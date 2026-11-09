const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = require("../server.js");

test("views do not use legacy PayPal SDK v5 and use v6 core", () => {
  const cartHtml = fs.readFileSync(path.join(__dirname, "../views/cart.html"), "utf8");
  const productHtml = fs.readFileSync(path.join(__dirname, "../views/product.html"), "utf8");

  // No legacy v5 script
  assert.equal(cartHtml.includes("paypal.com/sdk/js"), false);
  assert.equal(cartHtml.includes("paypal.Buttons"), false);

  // Uses v6 core
  assert.ok(cartHtml.includes('src="https://www.sandbox.paypal.com/web-sdk/v6/core"'));
  assert.ok(cartHtml.includes("<script async"));

  // createInstance
  assert.ok(cartHtml.includes('components: ["paypal-payments", "venmo-payments", "paypal-messages"]'));
  assert.ok(cartHtml.includes('pageType: "checkout"'));

  // findEligibleMethods
  assert.ok(cartHtml.includes('findEligibleMethods({ currencyCode: "USD" })'));

  // Web components
  assert.ok(cartHtml.includes("<paypal-button"));
  assert.ok(cartHtml.includes("<venmo-button"));
  assert.ok(cartHtml.includes("<paypal-message"));

  // Payment sessions and start()
  assert.ok(cartHtml.includes("createPayPalOneTimePaymentSession"));
  assert.ok(cartHtml.includes("createVenmoOneTimePaymentSession"));
  assert.ok(cartHtml.includes('session.start({ presentationMode: "auto" }, createOrder())'));

  // Pay Later messages on product page
  assert.ok(productHtml.includes('src="https://www.sandbox.paypal.com/web-sdk/v6/core"'));
  assert.ok(productHtml.includes("<paypal-message"));
  assert.ok(productHtml.includes("createPayPalMessages"));
});

test("cart has role=alert error container and Try again path without blanking page", () => {
  const cartHtml = fs.readFileSync(path.join(__dirname, "../views/cart.html"), "utf8");
  assert.ok(cartHtml.includes('role="alert"'));
  assert.ok(cartHtml.includes("Try again"));
  assert.equal(cartHtml.includes('document.body.innerHTML = ""'), false);
});

test("CSS does not collapse checkout actions on mobile screens", () => {
  const css = fs.readFileSync(path.join(__dirname, "../public/styles.css"), "utf8");
  assert.equal(css.includes("height: 0"), false);
  assert.ok(css.includes("paypal-button"));
  assert.ok(css.includes("venmo-button"));
});

test("server computes catalog total accurately and ignores client prices", () => {
  const compute = app.computeCatalogTotal;
  assert.ok(typeof compute === "function");

  // Single item
  const totalSingle = compute([{ id: "ridgeline-2p-tent", qty: 1 }]);
  assert.equal(totalSingle, "349.00");

  // Multiple items with quantities
  const totalMulti = compute([
    { id: "ridgeline-2p-tent", qty: 2 },
    { id: "summit-65-pack", qty: 1 },
  ]);
  assert.equal(totalMulti, "927.00");

  // Client attempts to spoof price and total
  const spoofed = compute([
    { id: "cinder-down-bag", price: "0.01", qty: 1, total: "0.01" },
  ]);
  assert.equal(spoofed, "289.00");

  // Missing quantity defaults to 1
  const missingQty = compute([{ id: "oakleaf-flannel" }]);
  assert.equal(missingQty, "68.00");

  // Empty or invalid inputs
  assert.equal(compute([]), null);
  assert.equal(compute(null), null);
  assert.equal(compute([{ id: "non-existent-item" }]), null);
});

test("server webhook route rejects unverified calls with 400", async () => {
  const layer = app._router.stack.find((l) => l.route && l.route.path === "/api/webhooks/paypal");
  assert.ok(layer, "webhook route exists");
  const handler = layer.route.stack[0].handle;

  let statusCode = 0;
  let jsonResponse = null;
  const mockReq = {
    headers: {},
    body: { event_type: "PAYMENT.CAPTURE.COMPLETED" },
  };
  const mockRes = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      jsonResponse = data;
      return this;
    },
  };

  await handler(mockReq, mockRes);
  assert.equal(statusCode, 400, "webhook without verification headers must reject with 400");
  assert.ok(jsonResponse && jsonResponse.error);
});

test("server orders route rejects empty or invalid items with 400", async () => {
  const layer = app._router.stack.find((l) => l.route && l.route.path === "/api/orders" && l.route.methods.post);
  assert.ok(layer, "orders route exists");
  const handler = layer.route.stack[0].handle;

  let statusCode = 0;
  let jsonResponse = null;
  const mockReq = {
    headers: {},
    body: { items: [] },
  };
  const mockRes = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      jsonResponse = data;
      return this;
    },
  };

  await handler(mockReq, mockRes);
  assert.equal(statusCode, 400, "orders endpoint with empty items must reject with 400");
  assert.ok(jsonResponse && jsonResponse.error);
});
