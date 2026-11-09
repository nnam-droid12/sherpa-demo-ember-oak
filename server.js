const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 8080;
const PAYPAL_BASE = "https://api-m.sandbox.paypal.com";
const products = require("./products.json");

app.use(express.json());

const partial = (name) => fs.readFileSync(path.join(__dirname, "views", "partials", name), "utf8");

function page(name) {
  const html = fs.readFileSync(path.join(__dirname, "views", name), "utf8");
  return html
    .replaceAll("{{HEADER}}", partial("header.html"))
    .replaceAll("{{FOOTER}}", partial("footer.html"))
    .replaceAll("{{PAYPAL_CLIENT_ID}}", process.env.PAYPAL_CLIENT_ID || "sb");
}

let cachedToken = null;
let tokenExpiresAt = 0;

async function accessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) {
    return cachedToken;
  }
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(data.error_description || "Failed to obtain PayPal access token");
  }
  cachedToken = data.access_token;
  tokenExpiresAt = now + ((data.expires_in || 300) - 30) * 1000;
  return cachedToken;
}

const orderTotals = new Map();
const carts = new Map();

function getOrigin(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.get("host") || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function sendCartApiError(res, status, name, message) {
  return res.status(status).json({
    name,
    message,
    debug_id: crypto.randomUUID(),
  });
}

function computeCatalogTotal(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  let total = 0;
  for (const item of items) {
    if (!item || (!item.id && !item.item_id)) continue;
    const itemId = item.id || item.item_id;
    const product = products.find((p) => p.id === itemId);
    if (!product) continue;
    const qty = Math.max(1, parseInt(item.qty ?? item.quantity, 10) || 1);
    total += Number(product.price) * qty;
  }
  return total > 0 ? total.toFixed(2) : null;
}

async function createPayPalOrder(total, origin) {
  const token = await accessToken();
  const response = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{ amount: { currency_code: "USD", value: total } }],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: `${origin}/thank-you`,
            cancel_url: `${origin}/cart`,
            user_action: "PAY_NOW",
          },
        },
      },
    }),
  });
  const data = await response.json();
  if (data.id) {
    orderTotals.set(data.id, total);
  }
  return data;
}

function validateAndPriceCart(cartData) {
  const validation_issues = [];
  const rawItems = Array.isArray(cartData.items) ? cartData.items : [];
  const pricedItems = [];
  let subtotalNum = 0;
  let hasPreorder = false;
  let maxLeadDays = 0;

  if (rawItems.length === 0) {
    validation_issues.push({
      code: "INVENTORY_ISSUE",
      type: "MISSING_FIELD",
      message: "Cart must contain at least one item.",
      user_message: "Your cart is empty.",
      field: "items",
      context: { specific_issue: "EMPTY_CART" },
      resolution_options: [{ action: "ADD_ITEMS" }],
    });
  } else {
    for (let i = 0; i < rawItems.length; i++) {
      const line = rawItems[i];
      const itemId = line?.item_id || line?.id;
      const product = products.find((p) => p.id === itemId);
      const qty = Math.max(1, parseInt(line?.quantity ?? line?.qty, 10) || 1);

      if (!product) {
        validation_issues.push({
          code: "INVENTORY_ISSUE",
          type: "INVALID_DATA",
          message: `Item '${itemId}' not found in catalog.`,
          user_message: `Item '${itemId}' is not available.`,
          field: `items[${i}].item_id`,
          context: { specific_issue: "INVALID_ITEM_ID" },
          resolution_options: [{ action: "REMOVE_ITEM" }],
        });
      } else {
        const itemPrice = Number(product.price) || 0;
        subtotalNum += itemPrice * qty;
        const pricedItem = {
          item_id: product.id,
          quantity: qty,
          name: product.title,
          price: {
            currency_code: "USD",
            value: product.price,
          },
        };
        if (line.variant_id !== undefined) {
          pricedItem.variant_id = line.variant_id;
        }
        pricedItems.push(pricedItem);

        if (product.availability === "preorder" || (product.lead_time_days && product.lead_time_days > 0)) {
          hasPreorder = true;
          const lead = product.lead_time_days || 3;
          if (lead > maxLeadDays) maxLeadDays = lead;
        }
      }
    }
  }

  const ship = cartData.shipping_address;
  if (!ship || typeof ship !== "object" || !ship.address_line_1) {
    validation_issues.push({
      code: "SHIPPING_ERROR",
      type: "MISSING_FIELD",
      message: "A shipping address is required.",
      user_message: "Please provide a shipping address.",
      field: "shipping_address",
      context: { specific_issue: "MISSING_SHIPPING_ADDRESS" },
      resolution_options: [{ action: "PROVIDE_MISSING_FIELD" }],
    });
  }

  if (hasPreorder) {
    const fields = Array.isArray(cartData.checkout_fields) ? cartData.checkout_fields : [];
    const deliveryField = fields.find((f) => f && f.type === "DELIVERY_DATE_PREFERENCE");
    if (!deliveryField || !deliveryField.value) {
      validation_issues.push({
        code: "DATA_ERROR",
        type: "MISSING_FIELD",
        message: "A delivery date is required for preorder items.",
        user_message: "Which day should we deliver your order?",
        field: "checkout_fields.DELIVERY_DATE_PREFERENCE",
        context: { specific_issue: "MISSING_CHECKOUT_FIELDS" },
        resolution_options: [{ action: "PROVIDE_MISSING_FIELD" }],
      });
    } else {
      const prefStr = String(deliveryField.value).trim();
      const prefDate = new Date(prefStr.includes("T") ? prefStr : prefStr + "T00:00:00Z");
      const now = new Date();
      const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const minDateUTC = new Date(todayUTC.getTime() + maxLeadDays * 24 * 60 * 60 * 1000);

      if (isNaN(prefDate.getTime()) || prefDate.getTime() < minDateUTC.getTime()) {
        validation_issues.push({
          code: "DATA_ERROR",
          type: "MISSING_FIELD",
          message: `Delivery date must be at least ${maxLeadDays} days in advance.`,
          user_message: `Please choose a delivery date at least ${maxLeadDays} days in advance.`,
          field: "checkout_fields.DELIVERY_DATE_PREFERENCE",
          context: { specific_issue: "INVALID_CHECKOUT_FIELD_VALUE" },
          resolution_options: [{ action: "PROVIDE_MISSING_FIELD" }],
        });
      }
    }
  }

  const subtotalStr = subtotalNum.toFixed(2);
  const totalStr = subtotalStr;

  return {
    pricedItems,
    validation_issues,
    validation_status: validation_issues.length === 0 ? "VALID" : "INVALID",
    totals: {
      subtotal: { currency_code: "USD", value: subtotalStr },
      shipping: { currency_code: "USD", value: "0.00" },
      tax: { currency_code: "USD", value: "0.00" },
      total: { currency_code: "USD", value: totalStr },
    },
  };
}

// 1. Catalog feed
app.get("/catalog.json", (req, res) => {
  const origin = getOrigin(req);
  const items = products.map((p) => {
    return {
      id: p.id,
      title: p.title,
      description: p.description,
      price: {
        currency_code: "USD",
        value: p.price,
      },
      availability: p.availability || (p.stock > 0 ? "in_stock" : "out_of_stock"),
      image_url: p.image.startsWith("http") ? p.image : `${origin}${p.image}`,
      url: `${origin}/product/${p.id}`,
      variants: p.variants || [],
      category: p.category,
      stock: p.stock,
      rating: p.rating,
      reviews: p.reviews,
      badge: p.badge || "",
      specs: p.specs || [],
      lead_time: p.lead_time || "2 business days",
      lead_time_days: p.lead_time_days ?? (p.availability === "preorder" ? 3 : 0),
    };
  });
  res.json({ items });
});

// 2. PayPal Cart API v1 endpoints
app.post("/merchant-cart", async (req, res) => {
  try {
    const cartId = "cart_" + crypto.randomBytes(4).toString("hex");
    const validation = validateAndPriceCart(req.body || {});
    const cart = {
      id: cartId,
      status: "CREATED",
      validation_status: validation.validation_status,
      validation_issues: validation.validation_issues,
      items: validation.pricedItems,
      totals: validation.totals,
      payment_method: { type: "paypal" },
    };
    if (req.body?.customer) cart.customer = req.body.customer;
    if (req.body?.shipping_address) cart.shipping_address = req.body.shipping_address;
    if (req.body?.checkout_fields) cart.checkout_fields = req.body.checkout_fields;

    if (Number(validation.totals.total.value) > 0) {
      try {
        const origin = getOrigin(req);
        const order = await createPayPalOrder(validation.totals.total.value, origin);
        if (order?.id) {
          cart.payment_method = { type: "paypal", token: order.id };
        }
      } catch (err) {
        console.error("PayPal order creation error in POST /merchant-cart:", err);
      }
    }

    carts.set(cartId, cart);
    return res.status(201).json(cart);
  } catch (err) {
    console.error("POST /merchant-cart error:", err);
    return sendCartApiError(res, 500, "INTERNAL_SERVER_ERROR", err.message || "Failed to create cart");
  }
});

app.get("/merchant-cart/:id", (req, res) => {
  const cart = carts.get(req.params.id);
  if (!cart) {
    return sendCartApiError(res, 404, "CART_NOT_FOUND", `Cart ${req.params.id} not found`);
  }
  return res.status(200).json(cart);
});

app.put("/merchant-cart/:id", async (req, res) => {
  try {
    const cartId = req.params.id;
    const existing = carts.get(cartId);
    if (!existing) {
      return sendCartApiError(res, 404, "CART_NOT_FOUND", `Cart ${cartId} not found`);
    }

    const validation = validateAndPriceCart(req.body || {});
    const cart = {
      id: cartId,
      status: validation.validation_issues.length > 0 ? "INCOMPLETE" : "CREATED",
      validation_status: validation.validation_status,
      validation_issues: validation.validation_issues,
      items: validation.pricedItems,
      totals: validation.totals,
      payment_method: { type: "paypal" },
    };
    if (req.body?.customer) cart.customer = req.body.customer;
    if (req.body?.shipping_address) cart.shipping_address = req.body.shipping_address;
    if (req.body?.checkout_fields) cart.checkout_fields = req.body.checkout_fields;

    if (Number(validation.totals.total.value) > 0) {
      try {
        const origin = getOrigin(req);
        const order = await createPayPalOrder(validation.totals.total.value, origin);
        if (order?.id) {
          cart.payment_method = { type: "paypal", token: order.id };
        }
      } catch (err) {
        console.error("PayPal order recreation error in PUT /merchant-cart:", err);
      }
    }

    carts.set(cartId, cart);
    return res.status(200).json(cart);
  } catch (err) {
    console.error("PUT /merchant-cart error:", err);
    return sendCartApiError(res, 500, "INTERNAL_SERVER_ERROR", err.message || "Failed to update cart");
  }
});

app.post("/merchant-cart/:id/checkout", async (req, res) => {
  try {
    const cartId = req.params.id;
    const cart = carts.get(cartId);
    if (!cart) {
      return sendCartApiError(res, 404, "CART_NOT_FOUND", `Cart ${cartId} not found`);
    }

    if (cart.status === "COMPLETED") {
      return res.status(200).json(cart);
    }

    if (cart.validation_status === "INVALID" || (cart.validation_issues && cart.validation_issues.length > 0)) {
      return res.status(200).json(cart);
    }

    const orderId = cart.payment_method?.token;
    if (!orderId) {
      return sendCartApiError(res, 422, "UNPROCESSABLE_ENTITY", "No PayPal payment token associated with this cart.");
    }

    const token = await accessToken();
    const orderRes = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!orderRes.ok) {
      return sendCartApiError(res, 422, "UNPROCESSABLE_ENTITY", "Unable to fetch PayPal order.");
    }
    const orderData = await orderRes.json();

    let capturedAmount;
    if (orderData.status === "APPROVED") {
      const captureRes = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderId}/capture`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      const captureData = await captureRes.json();
      if (!captureRes.ok || captureData.status !== "COMPLETED") {
        return sendCartApiError(res, 422, "UNPROCESSABLE_ENTITY", captureData.message || "Failed to capture payment.");
      }
      capturedAmount =
        captureData.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value ||
        captureData.purchase_units?.[0]?.amount?.value;
    } else if (orderData.status === "COMPLETED") {
      capturedAmount =
        orderData.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value ||
        orderData.purchase_units?.[0]?.amount?.value;
    } else {
      return sendCartApiError(res, 422, "UNPROCESSABLE_ENTITY", "The buyer must approve the PayPal payment first.");
    }

    if (capturedAmount && capturedAmount !== cart.totals.total.value) {
      return sendCartApiError(
        res,
        422,
        "UNPROCESSABLE_ENTITY",
        `Captured amount ${capturedAmount} does not match cart total ${cart.totals.total.value}`
      );
    }

    const origin = getOrigin(req);
    cart.status = "COMPLETED";
    cart.payment_confirmation = {
      merchant_order_number: `ORD-${orderId}`,
      order_review_page: `${origin}/thank-you?order=${orderId}`,
    };

    return res.status(200).json(cart);
  } catch (err) {
    console.error("Checkout error:", err);
    return sendCartApiError(res, 500, "INTERNAL_SERVER_ERROR", err.message || "Checkout failed");
  }
});

// Existing storefront and API routes
app.get("/", (_req, res) => res.send(page("index.html")));
app.get("/product/:id", (_req, res) => res.send(page("product.html")));
app.get("/cart", (_req, res) => res.send(page("cart.html")));
app.get("/thank-you", (_req, res) => res.send(page("thank-you.html")));
app.get("/api/products", (_req, res) => res.json(products));
app.get("/api/products/:id", (req, res) => {
  const product = products.find((p) => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: "not found" });
  res.json(product);
});

// Computes the order amount from server-side catalog; never trusts client total.
app.post("/api/orders", async (req, res) => {
  try {
    const items = req.body?.items || req.body?.cart;
    const total = computeCatalogTotal(items);
    if (!total) {
      return res.status(400).json({ error: "Invalid or empty cart" });
    }

    const token = await accessToken();
    const response = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{ amount: { currency_code: "USD", value: total } }],
      }),
    });
    const data = await response.json();
    if (data.id) {
      orderTotals.set(data.id, total);
      if (orderTotals.size > 1000) {
        const firstKey = orderTotals.keys().next().value;
        orderTotals.delete(firstKey);
      }
    }
    return res.status(response.status).json(data);
  } catch (err) {
    console.error("Order creation error:", err);
    return res.status(500).json({ error: "Failed to create order" });
  }
});

app.post("/api/orders/:id/capture", async (req, res) => {
  try {
    const orderId = req.params.id;
    if (!orderId) {
      return res.status(400).json({ error: "Missing order ID" });
    }

    const token = await accessToken();
    const response = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderId}/capture`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    const captureData = await response.json();

    const capturedAmount =
      captureData.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value ||
      captureData.purchase_units?.[0]?.amount?.value;

    let expectedTotal = orderTotals.get(orderId);
    if (!expectedTotal && (req.body?.items || req.body?.cart)) {
      expectedTotal = computeCatalogTotal(req.body.items || req.body.cart);
    }

    if (expectedTotal && capturedAmount && capturedAmount !== expectedTotal) {
      console.error(`Amount mismatch for order ${orderId}: expected ${expectedTotal}, got ${capturedAmount}`);
      return res.status(400).json({
        error: "Captured amount mismatch",
        expected: expectedTotal,
        actual: capturedAmount,
      });
    }

    return res.status(response.status).json(captureData);
  } catch (err) {
    console.error("Capture error:", err);
    return res.status(500).json({ error: "Failed to capture order" });
  }
});

app.post("/api/webhooks/paypal", async (req, res) => {
  try {
    const authAlgo = req.headers["paypal-auth-algo"] || req.headers["PAYPAL-AUTH-ALGO"];
    const certUrl = req.headers["paypal-cert-url"] || req.headers["PAYPAL-CERT-URL"];
    const transmissionId = req.headers["paypal-transmission-id"] || req.headers["PAYPAL-TRANSMISSION-ID"];
    const transmissionSig = req.headers["paypal-transmission-sig"] || req.headers["PAYPAL-TRANSMISSION-SIG"];
    const transmissionTime = req.headers["paypal-transmission-time"] || req.headers["PAYPAL-TRANSMISSION-TIME"];
    const webhookId = process.env.PAYPAL_WEBHOOK_ID;

    if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime || !webhookId) {
      return res.status(400).json({ error: "Missing required webhook verification headers or PAYPAL_WEBHOOK_ID" });
    }

    if (!req.body || typeof req.body !== "object" || !req.body.event_type) {
      return res.status(400).json({ error: "Invalid webhook payload" });
    }

    const token = await accessToken();
    const verifyResponse = await fetch(`${PAYPAL_BASE}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        auth_algo: authAlgo,
        cert_url: certUrl,
        transmission_id: transmissionId,
        transmission_sig: transmissionSig,
        transmission_time: transmissionTime,
        webhook_id: webhookId,
        webhook_event: req.body,
      }),
    });

    if (!verifyResponse.ok) {
      return res.status(400).json({ error: "Webhook verification call failed" });
    }

    const verifyData = await verifyResponse.json();
    if (verifyData.verification_status !== "SUCCESS") {
      return res.status(400).json({ error: "Webhook signature verification failed" });
    }

    const event = req.body;
    switch (event.event_type) {
      case "PAYMENT.CAPTURE.COMPLETED": {
        const capture = event.resource;
        console.log(`Handled PAYMENT.CAPTURE.COMPLETED: captureId=${capture?.id}, status=${capture?.status}`);
        break;
      }
      case "PAYMENT.CAPTURE.DENIED": {
        const capture = event.resource;
        console.log(`Handled PAYMENT.CAPTURE.DENIED: captureId=${capture?.id}, status=${capture?.status}`);
        break;
      }
      case "CHECKOUT.ORDER.APPROVED": {
        const order = event.resource;
        console.log(`Handled CHECKOUT.ORDER.APPROVED: orderId=${order?.id}, status=${order?.status}`);
        break;
      }
      default:
        console.log(`Handled webhook event: ${event.event_type}`);
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook processing error:", err);
    return res.status(400).json({ error: "Webhook processing error" });
  }
});

app.use(express.static(path.join(__dirname, "public")));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Ember & Oak listening on ${PORT}`));
}

app.computeCatalogTotal = computeCatalogTotal;
app.carts = carts;
app.validateAndPriceCart = validateAndPriceCart;

module.exports = app;
