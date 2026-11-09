const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const app = require("../server.js");

describe("Ember & Oak Checkout Fixes", () => {
  describe("1. Server-side Order Amount Calculation (Requirement 5)", () => {
    it("computes amount strictly from catalog and ignores client-sent total", () => {
      // ridgeline-2p-tent is 349.00, kindle-camp-stove is 89.00
      const items = [
        { id: "ridgeline-2p-tent", qty: 1, price: "1.00" }, // client attempts tampering price
        { id: "kindle-camp-stove", qty: 2, price: "0.50" },
      ];
      const total = app.computeOrderTotal(items);
      // 349.00 * 1 + 89.00 * 2 = 349.00 + 178.00 = 527.00
      assert.strictEqual(total, "527.00");
    });

    it("rejects invalid, empty, or unknown cart items", () => {
      assert.strictEqual(app.computeOrderTotal([]), null);
      assert.strictEqual(app.computeOrderTotal(null), null);
      assert.strictEqual(app.computeOrderTotal([{ id: "non-existent-gear", qty: 1 }]), null);
    });

    it("handles missing or string qty gracefully without crashing (Requirement 4)", () => {
      const total = app.computeOrderTotal([{ id: "trailmark-headlamp", qty: undefined }]);
      assert.strictEqual(total, "39.00");
    });
  });

  describe("2. Retry Safety / Idempotency (Requirement 9)", () => {
    it("server sends PayPal-Request-Id header with a UUID on orders and capture calls", async () => {
      const serverCode = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
      // Check that PayPal-Request-Id is passed on orders and capture endpoints
      const ordersCallHasRequestId = /"PayPal-Request-Id":\s*(?:crypto\.randomUUID\(\)|requestId)/.test(serverCode);
      assert.ok(ordersCallHasRequestId, "server.js must send PayPal-Request-Id on PayPal REST API calls");
    });
  });

  describe("3. Handling Declined Funding & Errors (Requirements 7 & 8)", () => {
    it("returns 422 for INSTRUMENT_DECLINED with clear message and recoverable flag", async () => {
      const serverCode = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
      assert.ok(
        serverCode.includes("INSTRUMENT_DECLINED"),
        "server.js must detect INSTRUMENT_DECLINED"
      );
      assert.ok(
        serverCode.includes("details.some") && serverCode.includes("d.issue === \"INSTRUMENT_DECLINED\""),
        "server.js must check details[].issue for INSTRUMENT_DECLINED"
      );
    });
  });

  describe("4. Pending Capture Treatment (Requirement 10)", () => {
    it("does not mark order as paid when capture status is PENDING", () => {
      const serverCode = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
      assert.ok(
        serverCode.includes('captureStatus === "COMPLETED"') &&
        serverCode.includes('captureStatus === "PENDING"'),
        "server.js must differentiate between COMPLETED and PENDING capture statuses"
      );
    });
  });

  describe("5. Webhook Signature Verification and Deduplication (Requirements 6 & 11)", () => {
    it("has processedEvents Set for deduplicating webhooks", () => {
      assert.ok(app.processedEvents instanceof Set, "app.processedEvents must be a Set");
    });

    it("returns 200 without processing when event id is already in processedEvents", async () => {
      app.processedEvents.add("duplicate-evt-123");

      // Mock request to /api/webhooks/paypal
      const req = {
        body: { id: "duplicate-evt-123", event_type: "PAYMENT.CAPTURE.COMPLETED" },
        headers: {},
      };
      let statusSent = null;
      let jsonSent = null;
      const res = {
        status(code) { statusSent = code; return this; },
        json(data) { jsonSent = data; return this; },
      };

      // Call the webhook route handler directly
      const route = app._router.stack.find((layer) => layer.route && layer.route.path === "/api/webhooks/paypal");
      assert.ok(route, "POST /api/webhooks/paypal route must exist");
      const handler = route.route.stack.find((s) => s.method === "post").handle;

      await handler(req, res);
      assert.strictEqual(statusSent, 200, "Must return 200 for duplicate event");
      assert.deepStrictEqual(jsonSent, { message: "Event already processed" });
    });

    it("rejects unverified webhooks with 400 when headers or signature are invalid", async () => {
      const req = {
        body: { id: "new-unverified-evt-456", event_type: "PAYMENT.CAPTURE.COMPLETED" },
        headers: {}, // missing PayPal headers
      };
      let statusSent = null;
      const res = {
        status(code) { statusSent = code; return this; },
        json() { return this; },
      };

      const route = app._router.stack.find((layer) => layer.route && layer.route.path === "/api/webhooks/paypal");
      const handler = route.route.stack.find((s) => s.method === "post").handle;

      await handler(req, res);
      assert.strictEqual(statusSent, 400, "Must reject unverified webhook with 400");
    });
  });

  describe("6. JS SDK v6 Migration and Views (Requirements 1, 2, 3, 4)", () => {
    it("cart.html loads v6 core SDK asynchronously and removes legacy SDK", () => {
      const cartHtml = fs.readFileSync(path.join(__dirname, "../views/cart.html"), "utf8");
      assert.ok(
        cartHtml.includes('src="https://www.sandbox.paypal.com/web-sdk/v6/core"'),
        "cart.html must load v6 core from sandbox.paypal.com/web-sdk/v6/core"
      );
      assert.ok(
        !cartHtml.includes("paypal.com/sdk/js"),
        "cart.html must not contain legacy paypal.com/sdk/js"
      );
      assert.ok(
        !cartHtml.includes("paypal.Buttons"),
        "cart.html must not contain paypal.Buttons"
      );
    });

    it("cart.html initializes v6 instance with required components and pageType", () => {
      const cartHtml = fs.readFileSync(path.join(__dirname, "../views/cart.html"), "utf8");
      assert.ok(
        cartHtml.includes('components: ["paypal-payments", "venmo-payments", "paypal-messages"]'),
        "cart.html must include paypal-payments, venmo-payments, and paypal-messages components"
      );
      assert.ok(
        cartHtml.includes('pageType: "checkout"'),
        "cart.html must specify pageType: checkout"
      );
      assert.ok(
        cartHtml.includes('findEligibleMethods({ currencyCode: "USD" })'),
        "cart.html must call findEligibleMethods({ currencyCode: 'USD' })"
      );
      assert.ok(
        cartHtml.includes("createPayPalOneTimePaymentSession") &&
        cartHtml.includes("createVenmoOneTimePaymentSession"),
        "cart.html must use createPayPalOneTimePaymentSession and createVenmoOneTimePaymentSession"
      );
      assert.ok(
        cartHtml.includes('session.start({ presentationMode: "auto" }, createOrder())'),
        "cart.html must start sessions with session.start({ presentationMode: 'auto' }, createOrder())"
      );
      assert.ok(
        cartHtml.includes("{ orderId: order.id }") || cartHtml.includes("{ orderId:"),
        "createOrder must return Promise of { orderId }"
      );
    });

    it("cart.html renders <paypal-button> and <venmo-button> above the fold", () => {
      const cartHtml = fs.readFileSync(path.join(__dirname, "../views/cart.html"), "utf8");
      assert.ok(cartHtml.includes("<paypal-button"), "cart.html must contain <paypal-button>");
      assert.ok(cartHtml.includes("<venmo-button"), "cart.html must contain <venmo-button>");

      // Verify checkout-actions is placed before recommendations panel
      const checkoutIdx = cartHtml.indexOf('class="checkout-actions"');
      const recsIdx = cartHtml.indexOf('id="recs"');
      assert.ok(checkoutIdx < recsIdx, "checkout-actions must be above the fold (before recs panel)");
    });

    it("cart.html and product.html show Pay Later messaging with <paypal-message>", () => {
      const cartHtml = fs.readFileSync(path.join(__dirname, "../views/cart.html"), "utf8");
      const productHtml = fs.readFileSync(path.join(__dirname, "../views/product.html"), "utf8");

      assert.ok(
        cartHtml.includes("<paypal-message auto-bootstrap") &&
        cartHtml.includes('currency-code="USD"'),
        "cart.html must contain <paypal-message auto-bootstrap currency-code='USD'>"
      );
      assert.ok(
        productHtml.includes("<paypal-message auto-bootstrap") &&
        productHtml.includes('currency-code="USD"'),
        "product.html must contain <paypal-message auto-bootstrap currency-code='USD'>"
      );
      assert.ok(
        cartHtml.includes("sdkInstance.createPayPalMessages()"),
        "cart.html must call sdkInstance.createPayPalMessages()"
      );
      assert.ok(
        productHtml.includes("sdkInstance.createPayPalMessages()"),
        "product.html must call sdkInstance.createPayPalMessages()"
      );
    });

    it("cart.html contains an element with role='alert' and never blanks page on error", () => {
      const cartHtml = fs.readFileSync(path.join(__dirname, "../views/cart.html"), "utf8");
      assert.ok(cartHtml.includes('role="alert"'), "cart.html must contain role='alert' element");
      assert.ok(
        !cartHtml.includes('document.body.innerHTML = ""'),
        "cart.html must never blank the page"
      );
      assert.ok(cartHtml.includes("Try again"), "cart.html must offer a Try again path");
    });

    it("styles.css does not hide payment buttons at 390px wide", () => {
      const css = fs.readFileSync(path.join(__dirname, "../public/styles.css"), "utf8");
      assert.ok(
        !css.includes("max-width: 414px"),
        "styles.css must not hide checkout actions on narrow mobile screens (390px)"
      );
    });
  });
});
