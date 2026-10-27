const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8080;
const PAYPAL_BASE = "https://api-m.sandbox.paypal.com";
const products = require("./products.json");

app.use(express.json());

function page(name) {
  const html = fs.readFileSync(path.join(__dirname, "views", name), "utf8");
  return html.replaceAll("{{PAYPAL_CLIENT_ID}}", process.env.PAYPAL_CLIENT_ID || "sb");
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

// Creates the PayPal order using the total the browser sends.
app.post("/api/orders", async (req, res) => {
  const { total } = req.body;
  const token = await accessToken();
  const response = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{ amount: { currency_code: "USD", value: String(total) } }],
    }),
  });
  res.status(response.status).json(await response.json());
});

app.post("/api/orders/:id/capture", async (req, res) => {
  const token = await accessToken();
  const response = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${req.params.id}/capture`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  res.status(response.status).json(await response.json());
});

app.post("/api/webhooks/paypal", (req, res) => {
  console.log("paypal webhook", req.body && req.body.event_type);
  res.sendStatus(200);
});

app.use(express.static(path.join(__dirname, "public")));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Ember & Oak listening on ${PORT}`));
}

module.exports = app;
