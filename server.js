const express = require("express");
const fs = require("fs");
const path = require("path");

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

app.get("/", (_req, res) => res.send(page("index.html")));
app.get("/product/:id", (_req, res) => res.send(page("product.html")));
app.get("/cart", (_req, res) => res.send(page("cart.html")));
app.get("/thank-you", (_req, res) => res.send(page("thank-you.html")));
app.get("/api/products", (_req, res) => res.json(products));
app.get("/catalog.json", (_req, res) => res.json(products));
app.get("/api/products/:id", (req, res) => {
  const product = products.find((p) => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: "not found" });
  res.json(product);
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
