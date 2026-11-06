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
let cachedAuthKey = null;

async function accessToken() {
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const now = Date.now();
  if (cachedToken && cachedAuthKey === auth && tokenExpiresAt > now + 60000) {
    return cachedToken;
  }
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  if (data.access_token) {
    cachedToken = data.access_token;
    cachedAuthKey = auth;
    tokenExpiresAt = now + (data.expires_in ? data.expires_in * 1000 : 3600000);
  }
  return data.access_token;
}

function calculateOrderTotal(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }
  let sum = 0;
  let count = 0;
  for (const item of items) {
    if (!item || !item.id) continue;
    const catalogProduct = products.find((p) => p.id === item.id);
    if (!catalogProduct) continue;
    const qty = Math.max(1, parseInt(item.qty || item.quantity || 1, 10) || 1);
    const price = Number(catalogProduct.price) || 0;
    sum += price * qty;
    count++;
  }
  return count > 0 ? sum.toFixed(2) : null;
}

const orderTotals = new Map();
const carts = new Map();
app.carts = carts;

function getOrigin(req) {
  const proto = req.get("x-forwarded-proto") || req.protocol || "http";
  const host = req.get("host") || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function validateAndFormatCart(body, existingCart = null) {
  const rawItems = Array.isArray(body && body.items) ? body.items : [];
  const validation_issues = [];

  const items = [];
  let subtotal = 0;

  if (rawItems.length === 0) {
    validation_issues.push({
      code: "INVENTORY_ISSUE",
      type: "MISSING_FIELD",
      message: "Cart must contain at least one item.",
      user_message: "Please add items to your cart.",
      field: "items",
    });
  } else {
    rawItems.forEach((rawItem, index) => {
      const itemId = rawItem && (rawItem.item_id || rawItem.id);
      const catalogProduct = products.find((p) => p.id === itemId);
      const quantity = Math.max(0, parseInt(rawItem && (rawItem.quantity || rawItem.qty) || 1, 10) || 1);

      if (!catalogProduct) {
        validation_issues.push({
          code: "INVENTORY_ISSUE",
          type: "INVALID_DATA",
          message: `Item '${itemId}' is not available in the catalog.`,
          user_message: `Item '${itemId}' could not be found.`,
          field: `items[${index}].item_id`,
          context: { specific_issue: "UNKNOWN_ITEM", item_id: itemId },
        });
        items.push({
          item_id: itemId || "unknown",
          quantity,
          name: (rawItem && rawItem.name) || itemId || "Unknown Item",
          price: { currency_code: "USD", value: "0.00" },
          ...(rawItem && rawItem.variant_id !== undefined ? { variant_id: rawItem.variant_id } : {}),
        });
      } else {
        const itemPrice = Number(catalogProduct.price) || 0;
        subtotal += itemPrice * quantity;
        items.push({
          item_id: catalogProduct.id,
          quantity,
          name: catalogProduct.title,
          price: { currency_code: "USD", value: itemPrice.toFixed(2) },
          ...(rawItem && rawItem.variant_id !== undefined ? { variant_id: rawItem.variant_id } : {}),
        });
      }
    });
  }

  // Shipping address validation
  const shippingAddress = body && body.shipping_address;
  if (
    !shippingAddress ||
    !shippingAddress.address_line_1 ||
    !shippingAddress.admin_area_2 ||
    !shippingAddress.admin_area_1 ||
    !shippingAddress.postal_code ||
    !shippingAddress.country_code
  ) {
    validation_issues.push({
      code: "SHIPPING_ERROR",
      type: "MISSING_FIELD",
      message: "A complete shipping address is required for delivery.",
      user_message: "Please provide a shipping address.",
      field: "shipping_address",
      context: { specific_issue: "MISSING_SHIPPING_ADDRESS" },
      resolution_options: [{ action: "PROVIDE_MISSING_FIELD" }],
    });
  }

  // Products that must be ordered ahead
  const orderAheadItems = items.filter((it) => {
    const prod = products.find((p) => p.id === it.item_id);
    return prod && (prod.availability === "preorder" || (prod.lead_time_days && prod.lead_time_days > 2));
  });

  if (orderAheadItems.length > 0) {
    const checkoutFields = Array.isArray(body && body.checkout_fields) ? body.checkout_fields : [];
    const datePref = checkoutFields.find((f) => f && f.type === "DELIVERY_DATE_PREFERENCE");

    const maxLeadTime = Math.max(
      ...orderAheadItems.map((it) => {
        const prod = products.find((p) => p.id === it.item_id);
        return (prod && prod.lead_time_days) || 3;
      })
    );

    if (!datePref || !datePref.value) {
      validation_issues.push({
        code: "DATA_ERROR",
        type: "MISSING_FIELD",
        message: "A delivery date preference is required for preorder items.",
        user_message: "Which day should we deliver your preorder item?",
        field: "checkout_fields.DELIVERY_DATE_PREFERENCE",
        context: { specific_issue: "MISSING_CHECKOUT_FIELDS" },
        resolution_options: [{ action: "PROVIDE_MISSING_FIELD" }],
      });
    } else {
      const prefDate = new Date(datePref.value.includes("T") ? datePref.value : `${datePref.value}T00:00:00Z`);
      const now = new Date();
      const minDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + maxLeadTime));

      if (isNaN(prefDate.getTime()) || prefDate.getTime() < minDate.getTime()) {
        validation_issues.push({
          code: "DATA_ERROR",
          type: "MISSING_FIELD",
          message: `The delivery date preference must be at least ${maxLeadTime} days in advance for preorder items.`,
          user_message: `Which day should we deliver your preorder item? (Earliest available: ${minDate.toISOString().split("T")[0]})`,
          field: "checkout_fields.DELIVERY_DATE_PREFERENCE",
          context: {
            specific_issue: "MISSING_CHECKOUT_FIELDS",
            minimum_lead_time_days: maxLeadTime,
            earliest_date: minDate.toISOString().split("T")[0],
          },
          resolution_options: [{ action: "PROVIDE_MISSING_FIELD" }],
        });
      }
    }
  }

  const totals = {
    subtotal: { currency_code: "USD", value: subtotal.toFixed(2) },
    shipping: { currency_code: "USD", value: "0.00" },
    tax: { currency_code: "USD", value: "0.00" },
    total: { currency_code: "USD", value: subtotal.toFixed(2) },
  };

  const validation_status = validation_issues.length === 0 ? "VALID" : "INVALID";

  const cart = {
    id: existingCart ? existingCart.id : `cart_${crypto.randomBytes(3).toString("hex")}`,
    status: existingCart ? (validation_status === "VALID" ? "CREATED" : "INCOMPLETE") : "CREATED",
    validation_status,
    validation_issues,
    items,
    totals,
    payment_method: existingCart ? existingCart.payment_method : { type: "paypal" },
  };

  if (body && body.customer) {
    cart.customer = body.customer;
  }
  if (body && body.shipping_address) {
    cart.shipping_address = body.shipping_address;
  }
  if (body && Array.isArray(body.checkout_fields)) {
    cart.checkout_fields = body.checkout_fields;
  }

  return cart;
}

async function createPayPalCartOrder(cart, origin) {
  const totalValue = cart.totals && cart.totals.total && cart.totals.total.value;
  if (!totalValue || Number(totalValue) <= 0) {
    cart.payment_method = { type: "paypal", token: null };
    return;
  }

  const token = await accessToken();
  const res = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: "USD",
            value: totalValue,
          },
        },
      ],
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

  const orderData = await res.json();
  if (!res.ok || !orderData.id) {
    const error = new Error(orderData.message || "Failed to create PayPal order");
    error.details = orderData;
    throw error;
  }

  cart.payment_method = {
    type: "paypal",
    token: orderData.id,
  };
  orderTotals.set(orderData.id, totalValue);
}

app.get("/", (_req, res) => res.send(page("index.html")));
app.get("/product/:id", (_req, res) => res.send(page("product.html")));
app.get("/cart", (_req, res) => res.send(page("cart.html")));
app.get("/thank-you", (_req, res) => res.send(page("thank-you.html")));
app.get("/api/products", (_req, res) => res.json(products));

// Catalog feed for AI shopping agents
app.get("/catalog.json", (req, res) => {
  const origin = getOrigin(req);
  const items = products.map((p) => ({
    id: p.id,
    title: p.title,
    description: p.description,
    price: {
      currency_code: "USD",
      value: Number(p.price).toFixed(2),
    },
    availability: p.availability || (p.stock > 0 ? "in_stock" : "out_of_stock"),
    image_url: `${origin}${p.image}`,
    url: `${origin}/product/${p.id}`,
    variants: p.variants || [],
    category: p.category,
    stock: p.stock,
    lead_time: p.lead_time || "2 business days",
    lead_time_days: p.lead_time_days !== undefined ? p.lead_time_days : 2,
    specs: p.specs || [],
    rating: p.rating,
    reviews: p.reviews,
  }));
  res.json({ items });
});

app.get("/api/products/:id", (req, res) => {
  const product = products.find((p) => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: "not found" });
  res.json(product);
});

// PayPal Cart API v1 endpoints for agentic commerce
app.post("/merchant-cart", async (req, res) => {
  try {
    const origin = getOrigin(req);
    const cart = validateAndFormatCart(req.body || {});

    if (Number(cart.totals.total.value) > 0) {
      await createPayPalCartOrder(cart, origin);
    }

    carts.set(cart.id, cart);
    res.status(201).json(cart);
  } catch (err) {
    console.error("Cart creation error:", err);
    res.status(500).json({
      name: "INTERNAL_SERVER_ERROR",
      message: err.message || "Failed to create cart",
      debug_id: crypto.randomUUID(),
    });
  }
});

app.get("/merchant-cart/:id", (req, res) => {
  const cart = carts.get(req.params.id);
  if (!cart) {
    return res.status(404).json({
      name: "CART_NOT_FOUND",
      message: `Cart '${req.params.id}' not found`,
      debug_id: crypto.randomUUID(),
    });
  }
  res.json(cart);
});

app.put("/merchant-cart/:id", async (req, res) => {
  try {
    const existing = carts.get(req.params.id);
    if (!existing) {
      return res.status(404).json({
        name: "CART_NOT_FOUND",
        message: `Cart '${req.params.id}' not found`,
        debug_id: crypto.randomUUID(),
      });
    }

    const origin = getOrigin(req);
    // Full replace: pass existing cart to preserve id, body replaces contents
    const cart = validateAndFormatCart(req.body || {}, existing);

    if (Number(cart.totals.total.value) > 0) {
      await createPayPalCartOrder(cart, origin);
    } else {
      cart.payment_method = { type: "paypal", token: null };
    }

    carts.set(cart.id, cart);
    res.status(200).json(cart);
  } catch (err) {
    console.error("Cart update error:", err);
    res.status(500).json({
      name: "INTERNAL_SERVER_ERROR",
      message: err.message || "Failed to update cart",
      debug_id: crypto.randomUUID(),
    });
  }
});

app.post("/merchant-cart/:id/checkout", async (req, res) => {
  try {
    const cart = carts.get(req.params.id);
    if (!cart) {
      return res.status(404).json({
        name: "CART_NOT_FOUND",
        message: `Cart '${req.params.id}' not found`,
        debug_id: crypto.randomUUID(),
      });
    }

    if (cart.status === "COMPLETED") {
      return res.status(200).json(cart);
    }

    if (cart.validation_status === "INVALID") {
      return res.status(200).json(cart);
    }

    const orderId = cart.payment_method && cart.payment_method.token;
    if (!orderId) {
      return res.status(422).json({
        name: "UNPROCESSABLE_ENTITY",
        message: "No PayPal payment associated with this cart.",
        debug_id: crypto.randomUUID(),
      });
    }

    const token = await accessToken();

    const orderRes = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    const orderData = await orderRes.json();

    if (!orderRes.ok || orderData.status !== "APPROVED") {
      return res.status(422).json({
        name: "UNPROCESSABLE_ENTITY",
        message: "The buyer must approve the PayPal payment before checkout can be completed.",
        debug_id: crypto.randomUUID(),
      });
    }

    const capRes = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderId}/capture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    const capData = await capRes.json();

    if (!capRes.ok || capData.status !== "COMPLETED") {
      return res.status(422).json({
        name: "UNPROCESSABLE_ENTITY",
        message: "Failed to capture the approved PayPal payment.",
        debug_id: crypto.randomUUID(),
      });
    }

    const capturedValue = capData.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value;
    if (capturedValue && Number(capturedValue) !== Number(cart.totals.total.value)) {
      return res.status(400).json({
        name: "INVALID_REQUEST",
        message: `Captured amount ($${capturedValue}) does not match expected amount ($${cart.totals.total.value})`,
        debug_id: crypto.randomUUID(),
      });
    }

    cart.status = "COMPLETED";
    const origin = getOrigin(req);
    const merchantOrderNumber = `EO-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    cart.payment_confirmation = {
      merchant_order_number: merchantOrderNumber,
      order_review_page: `${origin}/thank-you?order=${orderId}`,
    };

    carts.set(cart.id, cart);
    res.status(200).json(cart);
  } catch (err) {
    console.error("Cart checkout error:", err);
    res.status(500).json({
      name: "INTERNAL_SERVER_ERROR",
      message: err.message || "Failed to process checkout",
      debug_id: crypto.randomUUID(),
    });
  }
});

// Creates the PayPal order computing the total from the server catalog.
app.post("/api/orders", async (req, res) => {
  const items = req.body && req.body.items;
  const calculatedTotal = calculateOrderTotal(items);

  if (!calculatedTotal) {
    return res.status(400).json({ error: "Cannot create order: cart is empty or contains invalid items" });
  }

  try {
    const token = await accessToken();
    const response = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{ amount: { currency_code: "USD", value: calculatedTotal } }],
      }),
    });

    const orderData = await response.json();
    if (response.ok && orderData.id) {
      orderTotals.set(orderData.id, calculatedTotal);
    }
    res.status(response.status).json(orderData);
  } catch (err) {
    console.error("Order creation error:", err);
    res.status(500).json({ error: "Failed to create order" });
  }
});

// Captures the PayPal order and verifies the captured amount matches.
app.post("/api/orders/:id/capture", async (req, res) => {
  const orderId = req.params.id;
  if (!orderId) {
    return res.status(400).json({ error: "Missing order ID" });
  }

  const expectedTotal = orderTotals.get(orderId) || (req.body && req.body.items ? calculateOrderTotal(req.body.items) : null);

  try {
    const token = await accessToken();
    const response = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderId}/capture`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });

    const captureData = await response.json();

    if (response.ok) {
      const capturedValue = captureData.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value;
      if (expectedTotal && capturedValue && Number(capturedValue) !== Number(expectedTotal)) {
        return res.status(400).json({
          error: `Captured amount ($${capturedValue}) does not match expected amount ($${expectedTotal})`,
        });
      }
    }

    res.status(response.status).json(captureData);
  } catch (err) {
    console.error("Order capture error:", err);
    res.status(500).json({ error: "Failed to capture order" });
  }
});

// Verifies and handles PayPal webhooks.
app.post("/api/webhooks/paypal", async (req, res) => {
  const authAlgo = req.get("paypal-auth-algo");
  const certUrl = req.get("paypal-cert-url");
  const transmissionId = req.get("paypal-transmission-id");
  const transmissionSig = req.get("paypal-transmission-sig");
  const transmissionTime = req.get("paypal-transmission-time");
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;

  if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime || !webhookId || !req.body) {
    return res.status(400).json({ error: "Missing required webhook verification headers or payload" });
  }

  try {
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

    const verifyData = await verifyResponse.json();
    if (!verifyResponse.ok || verifyData.verification_status !== "SUCCESS") {
      return res.status(400).json({ error: "Webhook verification failed" });
    }

    const event = req.body;
    const eventType = event.event_type;

    switch (eventType) {
      case "PAYMENT.CAPTURE.COMPLETED":
        console.log("Handled PAYMENT.CAPTURE.COMPLETED:", event.resource?.id);
        break;
      case "PAYMENT.CAPTURE.DENIED":
        console.log("Handled PAYMENT.CAPTURE.DENIED:", event.resource?.id);
        break;
      case "CHECKOUT.ORDER.APPROVED":
        console.log("Handled CHECKOUT.ORDER.APPROVED:", event.resource?.id);
        break;
      default:
        console.log("Received webhook event:", eventType);
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook verification error:", err);
    res.status(400).json({ error: "Webhook verification error" });
  }
});

app.use(express.static(path.join(__dirname, "public")));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Ember & Oak listening on ${PORT}`));
}

module.exports = app;
