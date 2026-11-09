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

async function accessToken() {
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  return data.access_token;
}

const orderTotals = new Map();

function computeCatalogTotal(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  let total = 0;
  for (const item of items) {
    if (!item || !item.id) continue;
    const product = products.find((p) => p.id === item.id);
    if (!product) continue;
    const qty = Math.max(1, parseInt(item.qty ?? item.quantity, 10) || 1);
    total += Number(product.price) * qty;
  }
  return total > 0 ? total.toFixed(2) : null;
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

module.exports = app;
