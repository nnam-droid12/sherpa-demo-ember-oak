const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

describe("PayPal SDK v6 Migration & Checkout Integrity", () => {
  const root = path.join(__dirname, "..");
  const cartHtml = fs.readFileSync(path.join(root, "views", "cart.html"), "utf8");
  const productHtml = fs.readFileSync(path.join(root, "views", "product.html"), "utf8");
  const stylesCss = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
  const storeJs = fs.readFileSync(path.join(root, "public", "store.js"), "utf8");
  const serverJs = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const app = require(path.join(root, "server.js"));

  let server;
  let baseUrl;

  before(async () => {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test("Cart HTML uses SDK v6 script and removes v5 legacy script", () => {
    assert.ok(
      cartHtml.includes('https://www.sandbox.paypal.com/web-sdk/v6/core'),
      "Cart must load SDK v6 from sandbox core URL"
    );
    assert.ok(!cartHtml.includes("paypal.com/sdk/js"), "Cart must not load legacy v5 SDK");
    assert.ok(!cartHtml.includes("paypal.Buttons"), "Cart must not call legacy paypal.Buttons");
  });

  test("Cart HTML initializes v6 instance and sessions correctly", () => {
    assert.ok(cartHtml.includes("paypal.createInstance"), "Cart must call window.paypal.createInstance");
    assert.ok(cartHtml.includes('"paypal-payments"'), "Cart must request paypal-payments component");
    assert.ok(cartHtml.includes('"venmo-payments"'), "Cart must request venmo-payments component");
    assert.ok(cartHtml.includes('"paypal-messages"'), "Cart must request paypal-messages component");
    assert.ok(cartHtml.includes('"checkout"'), "Cart must specify pageType checkout");
    assert.ok(cartHtml.includes("findEligibleMethods"), "Cart must call findEligibleMethods");
    assert.ok(cartHtml.includes("createPayPalOneTimePaymentSession"), "Cart must create PayPal payment session");
    assert.ok(cartHtml.includes("createVenmoOneTimePaymentSession"), "Cart must create Venmo payment session");
    assert.ok(cartHtml.includes('<paypal-button'), "Cart must include <paypal-button> web component");
    assert.ok(cartHtml.includes('<venmo-button'), "Cart must include <venmo-button> web component");
  });

  test("Pay Later messaging is present on product and cart pages", () => {
    assert.ok(
      cartHtml.includes("<paypal-message") && cartHtml.includes("auto-bootstrap") && cartHtml.includes('currency-code="USD"'),
      "Cart must contain <paypal-message auto-bootstrap amount=... currency-code=USD>"
    );
    assert.ok(
      productHtml.includes("<paypal-message") && productHtml.includes("auto-bootstrap") && productHtml.includes('currency-code="USD"'),
      "Product must contain <paypal-message auto-bootstrap amount=... currency-code=USD>"
    );
    assert.ok(productHtml.includes("https://www.sandbox.paypal.com/web-sdk/v6/core"), "Product must load SDK v6");
    assert.ok(productHtml.includes("createPayPalMessages"), "Product must call createPayPalMessages");
    assert.ok(cartHtml.includes("createPayPalMessages"), "Cart must call createPayPalMessages");
  });

  test("Checkout actions are rendered above the fold (before recommendation panels)", () => {
    const tableIndex = cartHtml.indexOf('class="cart-table"');
    const actionsIndex = cartHtml.indexOf('class="checkout-actions"');
    const recsIndex = cartHtml.indexOf('id="recs"');
    assert.ok(tableIndex !== -1 && actionsIndex !== -1 && recsIndex !== -1);
    assert.ok(tableIndex < actionsIndex, "Checkout actions must appear after cart items");
    assert.ok(actionsIndex < recsIndex, "Checkout actions must appear before recommendation panels");
  });

  test("Mobile visibility at 390px is not suppressed by CSS", () => {
    assert.ok(!stylesCss.includes("height: 0"), "Styles must not hide checkout-actions with height: 0");
    assert.ok(!stylesCss.includes("overflow: hidden;\n  }\n}"), "Styles must not collapse checkout-actions on small screens");
  });

  test("Graceful failure handling with role='alert' and 'Try again' path", () => {
    assert.ok(cartHtml.includes('id="status"'), "Cart must have #status element");
    assert.ok(cartHtml.includes('role="alert"'), "Cart must have an element with role='alert'");
    assert.ok(cartHtml.includes("Try again"), "Cart alert must provide a Try again path");
    assert.ok(!cartHtml.includes('document.body.innerHTML = ""'), "Cart must never blank the page on error");
  });

  test("Server computes order amount from catalog and rejects untrusted totals", () => {
    assert.ok(serverJs.includes("computeCatalogTotal") || serverJs.includes("catalog"), "Server must compute total from catalog");
    assert.ok(!serverJs.includes("value: String(total)"), "Server must not trust browser-supplied total");
  });

  test("Server endpoint POST /api/orders rejects invalid cart items with 400", async () => {
    const resEmpty = await fetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [] }),
    });
    assert.strictEqual(resEmpty.status, 400);

    const resInvalid = await fetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ id: "unknown-item", qty: 1 }] }),
    });
    assert.strictEqual(resInvalid.status, 400);
  });

  test("Server verifies webhook signature and rejects unverified events with 400", async () => {
    assert.ok(serverJs.includes("/v1/notifications/verify-webhook-signature"), "Server must call verify-webhook-signature");
    assert.ok(serverJs.includes("PAYPAL_WEBHOOK_ID"), "Server must use PAYPAL_WEBHOOK_ID");
    assert.ok(serverJs.includes("PAYMENT.CAPTURE.COMPLETED"), "Server must handle PAYMENT.CAPTURE.COMPLETED");
    assert.ok(serverJs.includes("PAYMENT.CAPTURE.DENIED"), "Server must handle PAYMENT.CAPTURE.DENIED");
    assert.ok(serverJs.includes("CHECKOUT.ORDER.APPROVED"), "Server must handle CHECKOUT.ORDER.APPROVED");

    // Call without required headers
    const res = await fetch(`${baseUrl}/api/webhooks/paypal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_type: "PAYMENT.CAPTURE.COMPLETED" }),
    });
    assert.strictEqual(res.status, 400);
  });
});
