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

app.use(express.json());

const partial = (name) => fs.readFileSync(path.join(__dirname, "views", "partials", name), "utf8");

function page(name) {
  const html = fs.readFileSync(path.join(__dirname, "views", name), "utf8");
  return html
    .replaceAll("{{HEADER}}", partial("header.html"))
    .replaceAll("{{FOOTER}}", partial("footer.html"))
    .replaceAll("{{PAYPAL_CLIENT_ID}}", process.env.PAYPAL_CLIENT_ID || "sb");
}

async function accessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID || "";
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET || "";
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
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

if (require.main === module) {
  app.listen(PORT, () => console.log(`Ember & Oak listening on ${PORT}`));
}

module.exports = app;
