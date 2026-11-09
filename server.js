const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 8080;
const PAYPAL_BASE = "https://api-m.sandbox.paypal.com";
const products = require("./products.json");

const orders = new Map();
const orderAmounts = new Map();
const processedEvents = new Set();
const carts = new Map();

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
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }
  const clientId = process.env.PAYPAL_CLIENT_ID || "";
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET || "";
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  if (data.access_token) {
    cachedToken = data.access_token;
    tokenExpiresAt = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
  }
  return data.access_token;
}

function computeOrderTotal(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }
  let totalCents = 0;
  for (const item of items) {
    if (!item || typeof item.id !== "string") continue;
    const product = products.find((p) => p.id === item.id);
    if (!product) continue;
    const qty = Math.max(1, parseInt(item.qty, 10) || 1);
    const priceCents = Math.round(parseFloat(product.price) * 100);
    totalCents += priceCents * qty;
  }
  if (totalCents <= 0) return null;
  return (totalCents / 100).toFixed(2);
}

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

function getOrigin(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.get("host") || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

app.get("/catalog.json", (req, res) => {
  const origin = getOrigin(req);
  const items = products.map((p) => {
    const item = {
      id: p.id,
      title: p.title,
      description: p.description,
      price: {
        currency_code: "USD",
        value: typeof p.price === "number" ? p.price.toFixed(2) : parseFloat(p.price).toFixed(2),
      },
      availability: p.availability || (p.preorder ? "preorder" : (p.stock > 0 ? "in_stock" : "out_of_stock")),
      image_url: `${origin}${p.image}`,
      url: `${origin}/product/${p.id}`,
      variants: p.variants || [],
      category: p.category,
      stock: p.stock,
      rating: p.rating,
      reviews: p.reviews,
      specs: p.specs || [],
      lead_time: p.lead_time || "2 business days",
      lead_time_days: p.lead_time_days || 2,
    };
    if (p.badge) {
      item.badge = p.badge;
    }
    const sleepsMatch = (p.specs || []).find((s) => typeof s === "string" && /sleeps\s*(\d+)/i.test(s));
    if (sleepsMatch) {
      const match = sleepsMatch.match(/sleeps\s*(\d+)/i);
      if (match) item.serves = parseInt(match[1], 10);
    }
    return item;
  });
  res.json({ items });
});

function isOrderAhead(product) {
  if (!product) return false;
  return (
    product.availability === "preorder" ||
    product.preorder === true ||
    product.order_ahead === true ||
    Boolean(product.lead_time_days && product.lead_time_days > 2)
  );
}

async function createPayPalOrderForCart(totalValue, origin) {
  const token = await accessToken();
  const requestId = crypto.randomUUID();
  const response = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": requestId,
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{ amount: { currency_code: "USD", value: totalValue } }],
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
  if (!response.ok || !data.id) {
    const err = new Error(data.message || "Failed to create PayPal order for cart");
    err.debug_id = data.debug_id;
    throw err;
  }

  orderAmounts.set(data.id, totalValue);
  orders.set(data.id, { id: data.id, status: "CREATED", amount: totalValue });
  return data.id;
}

async function buildAndValidateCart(cartId, body, origin, status = "CREATED") {
  const validationIssues = [];
  const cartItems = [];
  let totalCents = 0;
  let hasOrderAhead = false;

  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (rawItems.length === 0) {
    validationIssues.push({
      code: "INVENTORY_ISSUE",
      type: "MISSING_FIELD",
      message: "Cart must contain at least one item.",
      user_message: "Your cart is empty. Please add items to your cart.",
      field: "items",
      context: { specific_issue: "EMPTY_CART" },
      resolution_options: [{ action: "PROVIDE_MISSING_FIELD" }],
    });
  } else {
    for (const item of rawItems) {
      if (!item) continue;
      const itemId = item.item_id || item.id;
      const qty = Math.max(1, parseInt(item.quantity ?? item.qty ?? 1, 10) || 1);
      const product = products.find((p) => p.id === itemId);

      if (!product) {
        validationIssues.push({
          code: "INVENTORY_ISSUE",
          type: "INVALID_DATA",
          message: `Product with item_id '${itemId}' not found in catalog.`,
          user_message: `Item '${itemId}' is not available.`,
          field: "items",
          context: { specific_issue: "UNKNOWN_ITEM", item_id: itemId },
        });
        cartItems.push({
          item_id: itemId || "unknown",
          quantity: qty,
          name: "Unknown Item",
          price: { currency_code: "USD", value: "0.00" },
        });
        continue;
      }

      if (isOrderAhead(product)) {
        hasOrderAhead = true;
      }

      const priceCents = Math.round(parseFloat(product.price) * 100);
      totalCents += priceCents * qty;

      const formatted = {
        item_id: product.id,
        quantity: qty,
        name: product.title,
        price: { currency_code: "USD", value: (priceCents / 100).toFixed(2) },
      };
      if (item.variant_id !== undefined) {
        formatted.variant_id = item.variant_id;
      }
      cartItems.push(formatted);
    }
  }

  const shipping = body.shipping_address;
  if (!shipping || !shipping.address_line_1) {
    validationIssues.push({
      code: "SHIPPING_ERROR",
      type: "MISSING_FIELD",
      message: "A shipping address is required.",
      user_message: "Please provide a shipping address.",
      field: "shipping_address",
      context: { specific_issue: "MISSING_SHIPPING_ADDRESS" },
      resolution_options: [{ action: "PROVIDE_MISSING_FIELD" }],
    });
  }

  const checkoutFields = Array.isArray(body.checkout_fields) ? body.checkout_fields : [];
  const deliveryPref = checkoutFields.find((f) => f && f.type === "DELIVERY_DATE_PREFERENCE");

  if (hasOrderAhead) {
    if (!deliveryPref || !deliveryPref.value) {
      validationIssues.push({
        code: "DATA_ERROR",
        type: "MISSING_FIELD",
        message: "A delivery date is required for preorder items.",
        user_message: "Which day should we deliver your order?",
        field: "checkout_fields.DELIVERY_DATE_PREFERENCE",
        context: { specific_issue: "MISSING_CHECKOUT_FIELDS" },
        resolution_options: [{ action: "PROVIDE_MISSING_FIELD" }],
      });
    } else {
      const selectedDate = new Date(deliveryPref.value);
      const now = new Date();
      const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const minDate = new Date(todayUtc);
      minDate.setUTCDate(minDate.getUTCDate() + 2);

      if (isNaN(selectedDate.getTime()) || selectedDate < minDate) {
        validationIssues.push({
          code: "DATA_ERROR",
          type: "MISSING_FIELD",
          message: "The requested delivery date is too early.",
          user_message: "Please choose a delivery date at least 2 business days in advance.",
          field: "checkout_fields.DELIVERY_DATE_PREFERENCE",
          context: { specific_issue: "DELIVERY_DATE_TOO_EARLY" },
          resolution_options: [{ action: "PROVIDE_MISSING_FIELD" }],
        });
      }
    }
  } else if (deliveryPref && deliveryPref.value) {
    const selectedDate = new Date(deliveryPref.value);
    const now = new Date();
    const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    if (isNaN(selectedDate.getTime()) || selectedDate < todayUtc) {
      validationIssues.push({
        code: "DATA_ERROR",
        type: "MISSING_FIELD",
        message: "Delivery date preference is too early.",
        user_message: "Please choose a future delivery date.",
        field: "checkout_fields.DELIVERY_DATE_PREFERENCE",
        context: { specific_issue: "DELIVERY_DATE_TOO_EARLY" },
        resolution_options: [{ action: "PROVIDE_MISSING_FIELD" }],
      });
    }
  }

  const subtotalStr = (totalCents / 100).toFixed(2);
  const totals = {
    subtotal: { currency_code: "USD", value: subtotalStr },
    shipping: { currency_code: "USD", value: "0.00" },
    tax: { currency_code: "USD", value: "0.00" },
    total: { currency_code: "USD", value: subtotalStr },
  };

  const validation_status = validationIssues.length === 0 ? "VALID" : "INVALID";

  const cart = {
    id: cartId,
    status,
    validation_status,
    validation_issues: validationIssues,
    items: cartItems,
    totals,
  };

  if (body.customer) {
    cart.customer = body.customer;
  }
  if (body.shipping_address) {
    cart.shipping_address = body.shipping_address;
  }
  if (body.checkout_fields) {
    cart.checkout_fields = body.checkout_fields;
  }

  cart.payment_method = {
    type: body.payment_method?.type || "paypal",
  };

  if (totalCents > 0) {
    const orderId = await createPayPalOrderForCart(subtotalStr, origin);
    cart.payment_method.token = orderId;
  }

  return cart;
}

app.post("/merchant-cart", async (req, res) => {
  try {
    const cartId = `cart_${crypto.randomBytes(4).toString("hex")}`;
    const origin = getOrigin(req);
    const body = req.body || {};

    const cart = await buildAndValidateCart(cartId, body, origin, "CREATED");
    carts.set(cartId, cart);

    return res.status(201).json(cart);
  } catch (err) {
    console.error("POST /merchant-cart error:", err);
    return res.status(500).json({
      name: "INTERNAL_SERVER_ERROR",
      message: err.message || "Failed to create cart",
      debug_id: err.debug_id || crypto.randomUUID(),
    });
  }
});

app.get("/merchant-cart/:id", (req, res) => {
  const cart = carts.get(req.params.id);
  if (!cart) {
    return res.status(404).json({
      name: "CART_NOT_FOUND",
      message: `Cart '${req.params.id}' was not found.`,
      debug_id: crypto.randomUUID(),
    });
  }
  return res.status(200).json(cart);
});

app.put("/merchant-cart/:id", async (req, res) => {
  try {
    const existing = carts.get(req.params.id);
    if (!existing) {
      return res.status(404).json({
        name: "CART_NOT_FOUND",
        message: `Cart '${req.params.id}' was not found.`,
        debug_id: crypto.randomUUID(),
      });
    }

    const origin = getOrigin(req);
    const body = req.body || {};
    const cart = await buildAndValidateCart(req.params.id, body, origin, "CREATED");
    if (cart.validation_status === "INVALID") {
      cart.status = "INCOMPLETE";
    }

    carts.set(req.params.id, cart);
    return res.status(200).json(cart);
  } catch (err) {
    console.error("PUT /merchant-cart error:", err);
    return res.status(500).json({
      name: "INTERNAL_SERVER_ERROR",
      message: err.message || "Failed to update cart",
      debug_id: err.debug_id || crypto.randomUUID(),
    });
  }
});

app.post("/merchant-cart/:id/checkout", async (req, res) => {
  try {
    const cart = carts.get(req.params.id);
    if (!cart) {
      return res.status(404).json({
        name: "CART_NOT_FOUND",
        message: `Cart '${req.params.id}' was not found.`,
        debug_id: crypto.randomUUID(),
      });
    }

    if (cart.validation_status === "INVALID") {
      return res.status(200).json(cart);
    }

    if (cart.status === "COMPLETED") {
      return res.status(200).json(cart);
    }

    const orderId = cart.payment_method?.token;
    if (!orderId) {
      return res.status(422).json({
        name: "UNPROCESSABLE_ENTITY",
        message: "The buyer must approve the PayPal payment first.",
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

    if (!orderRes.ok) {
      const orderErr = await orderRes.json().catch(() => ({}));
      return res.status(422).json({
        name: "UNPROCESSABLE_ENTITY",
        message: orderErr.message || "The buyer must approve the PayPal payment first.",
        debug_id: orderErr.debug_id || crypto.randomUUID(),
      });
    }

    const orderData = await orderRes.json();

    if (orderData.status !== "APPROVED") {
      return res.status(422).json({
        name: "UNPROCESSABLE_ENTITY",
        message: "The buyer must approve the PayPal payment first.",
        debug_id: crypto.randomUUID(),
      });
    }

    const requestId = crypto.randomUUID();
    const captureRes = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderId}/capture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": requestId,
      },
    });

    const captureData = await captureRes.json();
    if (!captureRes.ok) {
      return res.status(422).json({
        name: "UNPROCESSABLE_ENTITY",
        message: captureData.message || "Failed to capture PayPal payment.",
        debug_id: captureData.debug_id || crypto.randomUUID(),
      });
    }

    const capture = captureData.purchase_units?.[0]?.payments?.captures?.[0];
    const capturedAmount = capture?.amount?.value;
    const expectedAmount = cart.totals?.total?.value;

    if (!capturedAmount || parseFloat(capturedAmount).toFixed(2) !== parseFloat(expectedAmount).toFixed(2)) {
      return res.status(422).json({
        name: "UNPROCESSABLE_ENTITY",
        message: "Captured amount does not match expected cart total.",
        debug_id: crypto.randomUUID(),
      });
    }

    const origin = getOrigin(req);
    cart.status = "COMPLETED";
    cart.payment_confirmation = {
      merchant_order_number: `EO-${cart.id.replace("cart_", "")}-${Date.now().toString(36).toUpperCase()}`,
      order_review_page: `${origin}/thank-you?order=${orderId}`,
    };

    orders.set(orderId, { id: orderId, status: "PAID", amount: capturedAmount });
    orderAmounts.set(orderId, capturedAmount);
    carts.set(cart.id, cart);

    return res.status(200).json(cart);
  } catch (err) {
    console.error("POST /merchant-cart/:id/checkout error:", err);
    return res.status(500).json({
      name: "INTERNAL_SERVER_ERROR",
      message: err.message || "Internal server error during checkout.",
      debug_id: crypto.randomUUID(),
    });
  }
});

// Creates the PayPal order using the catalog-computed total (never client-provided total).
app.post("/api/orders", async (req, res) => {
  try {
    const { items } = req.body || {};
    const computedTotal = computeOrderTotal(items);
    if (!computedTotal) {
      return res.status(400).json({ error: "Invalid or empty cart items" });
    }

    const token = await accessToken();
    const requestId = crypto.randomUUID();
    const response = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": requestId,
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{ amount: { currency_code: "USD", value: computedTotal } }],
      }),
    });

    const data = await response.json();
    if (response.ok && data.id) {
      orderAmounts.set(data.id, computedTotal);
      orders.set(data.id, { id: data.id, status: "CREATED", amount: computedTotal });
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
    const token = await accessToken();
    const requestId = crypto.randomUUID();
    const response = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderId}/capture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": requestId,
      },
    });

    const data = await response.json();

    // Check for INSTRUMENT_DECLINED
    const isInstrumentDeclined = Array.isArray(data.details) &&
      data.details.some((d) => d && d.issue === "INSTRUMENT_DECLINED");

    if (isInstrumentDeclined) {
      return res.status(422).json({
        error: "INSTRUMENT_DECLINED",
        details: data.details,
        message: "Your payment method was declined. Please choose another payment method.",
        recoverable: true,
      });
    }

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    // Verify captured amount matches server-calculated amount
    const expectedAmount = orderAmounts.get(orderId);
    const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
    const capturedAmount = capture?.amount?.value;

    if (expectedAmount && capturedAmount) {
      if (parseFloat(capturedAmount).toFixed(2) !== parseFloat(expectedAmount).toFixed(2)) {
        return res.status(400).json({
          error: "AMOUNT_MISMATCH",
          message: "Captured amount does not match expected order amount",
          expected: expectedAmount,
          captured: capturedAmount,
        });
      }
    }

    // Treat a capture whose status is PENDING as not yet paid
    const captureStatus = capture?.status || data.status;
    if (captureStatus === "COMPLETED") {
      orders.set(orderId, { id: orderId, status: "PAID", amount: capturedAmount || expectedAmount });
    } else if (captureStatus === "PENDING") {
      orders.set(orderId, { id: orderId, status: "PENDING", amount: capturedAmount || expectedAmount });
    }

    return res.status(response.status).json({
      ...data,
      status: captureStatus,
    });
  } catch (err) {
    console.error("Capture error:", err);
    return res.status(500).json({ error: "Failed to capture order" });
  }
});

app.post("/api/webhooks/paypal", async (req, res) => {
  try {
    const event = req.body;
    if (!event || !event.id) {
      return res.status(400).json({ error: "Missing event payload or event id" });
    }

    // Deduplicate: if event already processed, return 200 without reprocessing
    if (processedEvents.has(event.id)) {
      return res.status(200).json({ message: "Event already processed" });
    }

    const authAlgo = req.headers["paypal-auth-algo"];
    const certUrl = req.headers["paypal-cert-url"];
    const transmissionId = req.headers["paypal-transmission-id"];
    const transmissionSig = req.headers["paypal-transmission-sig"];
    const transmissionTime = req.headers["paypal-transmission-time"];
    const webhookId = process.env.PAYPAL_WEBHOOK_ID;

    if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime || !webhookId) {
      return res.status(400).json({ error: "Missing required PayPal webhook headers or PAYPAL_WEBHOOK_ID" });
    }

    const token = await accessToken();
    const verifyRes = await fetch(`${PAYPAL_BASE}/v1/notifications/verify-webhook-signature`, {
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
        webhook_event: event,
      }),
    });

    if (!verifyRes.ok) {
      return res.status(400).json({ error: "Webhook verification failed" });
    }

    const verifyData = await verifyRes.json();
    if (verifyData.verification_status !== "SUCCESS") {
      return res.status(400).json({ error: "Invalid webhook signature" });
    }

    processedEvents.add(event.id);

    const eventType = event.event_type;
    switch (eventType) {
      case "PAYMENT.CAPTURE.COMPLETED": {
        const capture = event.resource;
        const orderId = capture?.custom_id || capture?.supplementary_data?.related_ids?.order_id;
        if (orderId && orders.has(orderId)) {
          orders.set(orderId, { ...orders.get(orderId), status: "PAID", captureId: capture?.id });
        }
        console.log("Processed PAYMENT.CAPTURE.COMPLETED for capture:", capture?.id);
        break;
      }
      case "PAYMENT.CAPTURE.DENIED": {
        const capture = event.resource;
        const orderId = capture?.custom_id || capture?.supplementary_data?.related_ids?.order_id;
        if (orderId && orders.has(orderId)) {
          orders.set(orderId, { ...orders.get(orderId), status: "DENIED", captureId: capture?.id });
        }
        console.log("Processed PAYMENT.CAPTURE.DENIED for capture:", capture?.id);
        break;
      }
      case "CHECKOUT.ORDER.APPROVED": {
        const order = event.resource;
        if (order?.id && orders.has(order.id)) {
          orders.set(order.id, { ...orders.get(order.id), status: "APPROVED" });
        }
        console.log("Processed CHECKOUT.ORDER.APPROVED for order:", order?.id);
        break;
      }
      default:
        console.log("Unhandled webhook event type:", eventType);
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook processing error:", err);
    return res.status(400).json({ error: "Webhook error" });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.orders = orders;
app.orderAmounts = orderAmounts;
app.processedEvents = processedEvents;
app.computeOrderTotal = computeOrderTotal;
app.carts = carts;

if (require.main === module) {
  app.listen(PORT, () => console.log(`Ember & Oak listening on ${PORT}`));
}

module.exports = app;
