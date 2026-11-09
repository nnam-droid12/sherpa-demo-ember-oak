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

async function accessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
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

const orderTotals = new Map();

function computeCatalogTotal(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }
  let totalCents = 0;
  for (const item of items) {
    if (!item || !item.id) continue;
    const product = products.find((p) => p.id === item.id);
    if (!product) {
      return null;
    }
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

// Creates the PayPal order using the server-side catalog amounts.
app.post("/api/orders", async (req, res) => {
  try {
    const items = req.body && Array.isArray(req.body.items) ? req.body.items : [];
    const total = computeCatalogTotal(items);
    if (!total) {
      return res.status(400).json({ error: "Invalid or empty cart items" });
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
    const orderData = await response.json();
    if (response.ok && orderData.id) {
      orderTotals.set(orderData.id, total);
    }
    res.status(response.status).json(orderData);
  } catch (err) {
    console.error("Order creation error:", err);
    res.status(500).json({ error: "Internal server error creating order" });
  }
});

app.post("/api/orders/:id/capture", async (req, res) => {
  try {
    const orderId = req.params.id;
    let expectedTotal = orderTotals.get(orderId);
    if (!expectedTotal && req.body && Array.isArray(req.body.items)) {
      expectedTotal = computeCatalogTotal(req.body.items);
    }

    const token = await accessToken();
    const response = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderId}/capture`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    const captureData = await response.json();

    if (response.ok && captureData.status === "COMPLETED") {
      const captureObj = captureData.purchase_units?.[0]?.payments?.captures?.[0];
      const capturedAmount = captureObj?.amount?.value;
      if (expectedTotal && capturedAmount) {
        if (parseFloat(expectedTotal).toFixed(2) !== parseFloat(capturedAmount).toFixed(2)) {
          console.error(`Amount mismatch: expected ${expectedTotal}, captured ${capturedAmount}`);
          return res.status(400).json({
            error: "Captured amount does not match expected total",
            expected: expectedTotal,
            actual: capturedAmount,
          });
        }
      }
    }

    res.status(response.status).json(captureData);
  } catch (err) {
    console.error("Order capture error:", err);
    res.status(500).json({ error: "Internal server error capturing order" });
  }
});

app.post("/api/webhooks/paypal", async (req, res) => {
  try {
    const authAlgo = req.get("paypal-auth-algo");
    const certUrl = req.get("paypal-cert-url");
    const transmissionId = req.get("paypal-transmission-id");
    const transmissionSig = req.get("paypal-transmission-sig");
    const transmissionTime = req.get("paypal-transmission-time");
    const webhookId = process.env.PAYPAL_WEBHOOK_ID;

    if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime || !webhookId) {
      return res.status(400).json({ error: "Missing required webhook verification headers or PAYPAL_WEBHOOK_ID" });
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
        webhook_event: req.body,
      }),
    });

    const verification = await verifyRes.json();
    if (!verifyRes.ok || verification.verification_status !== "SUCCESS") {
      return res.status(400).json({ error: "Webhook signature verification failed" });
    }

    const event = req.body || {};
    switch (event.event_type) {
      case "PAYMENT.CAPTURE.COMPLETED":
        console.log("Handled PAYMENT.CAPTURE.COMPLETED:", event.resource && event.resource.id);
        break;
      case "PAYMENT.CAPTURE.DENIED":
        console.log("Handled PAYMENT.CAPTURE.DENIED:", event.resource && event.resource.id);
        break;
      case "CHECKOUT.ORDER.APPROVED":
        console.log("Handled CHECKOUT.ORDER.APPROVED:", event.resource && event.resource.id);
        break;
      default:
        console.log("Received PayPal webhook event:", event.event_type);
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook processing error:", err);
    res.status(400).json({ error: "Webhook processing error" });
  }
});

app.use(express.static(path.join(__dirname, "public")));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Ember & Oak listening on ${PORT}`));
}

module.exports = app;
