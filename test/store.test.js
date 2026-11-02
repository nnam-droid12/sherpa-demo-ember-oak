const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const app = require("../server.js");

describe("PayPal SDK v6 Migration & Checkout Integrity", () => {
  it("cart view loads v6 core script and has no legacy sdk script or paypal.Buttons", () => {
    const cartHtml = fs.readFileSync(path.join(__dirname, "..", "views", "cart.html"), "utf8");
    assert.match(cartHtml, /<script async src="https:\/\/www\.sandbox\.paypal\.com\/web-sdk\/v6\/core">/);
    assert.doesNotMatch(cartHtml, /paypal\.com\/sdk\/js/);
    assert.doesNotMatch(cartHtml, /paypal\.Buttons\s*\(/);
    assert.match(cartHtml, /window\.paypal\.createInstance/);
    assert.match(cartHtml, /components:\s*\["paypal-payments",\s*"venmo-payments",\s*"paypal-messages"\]/);
    assert.match(cartHtml, /findEligibleMethods\(\{\s*currencyCode:\s*"USD"\s*\}\)/);
    assert.match(cartHtml, /<paypal-button/);
    assert.match(cartHtml, /<venmo-button/);
    assert.match(cartHtml, /createPayPalOneTimePaymentSession/);
    assert.match(cartHtml, /createVenmoOneTimePaymentSession/);
    assert.match(cartHtml, /session\.start\(\s*\{\s*presentationMode:\s*"auto"\s*\}\s*,\s*createOrder\(\)\s*\)/);
  });

  it("cart view includes pay later message and role='alert' error handling", () => {
    const cartHtml = fs.readFileSync(path.join(__dirname, "..", "views", "cart.html"), "utf8");
    assert.match(cartHtml, /<paypal-message[^>]*auto-bootstrap[^>]*amount=/);
    assert.match(cartHtml, /role="alert"/);
    assert.match(cartHtml, /Try again/);
    assert.doesNotMatch(cartHtml, /document\.body\.innerHTML\s*=\s*""/);
  });

  it("product view loads v6 core script and pay later message", () => {
    const productHtml = fs.readFileSync(path.join(__dirname, "..", "views", "product.html"), "utf8");
    assert.match(productHtml, /<script async src="https:\/\/www\.sandbox\.paypal\.com\/web-sdk\/v6\/core">/);
    assert.match(productHtml, /<paypal-message[^>]*auto-bootstrap/);
    assert.match(productHtml, /createPayPalMessages/);
  });

  it("styles.css does not hide checkout-actions on mobile (390px)", () => {
    const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
    assert.doesNotMatch(css, /height:\s*0;\s*padding:\s*0;\s*overflow:\s*hidden;/);
  });

  it("server calculates order amount from catalog and rejects invalid carts", async () => {
    const server = app.listen(0);
    const port = server.address().port;

    try {
      // Empty items
      const resEmpty = await fetch(`http://localhost:${port}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [] }),
      });
      assert.strictEqual(resEmpty.status, 400);

      // Missing body / empty object
      const resNoBody = await fetch(`http://localhost:${port}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.strictEqual(resNoBody.status, 400);

      // Unknown product ID
      const resBadId = await fetch(`http://localhost:${port}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ id: "non-existent-item", qty: 1 }] }),
      });
      assert.strictEqual(resBadId.status, 400);
    } finally {
      server.close();
    }
  });

  it("webhook endpoint rejects unverified events with 400 when headers or webhook ID are missing", async () => {
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const res = await fetch(`http://localhost:${port}/api/webhooks/paypal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_type: "PAYMENT.CAPTURE.COMPLETED" }),
      });
      assert.strictEqual(res.status, 400);
    } finally {
      server.close();
    }
  });

  it("webhook endpoint verifies signature and handles events", async () => {
    const server = app.listen(0);
    const port = server.address().port;

    const originalFetch = global.fetch;

    try {
      process.env.PAYPAL_WEBHOOK_ID = "WH-123456789";

      global.fetch = async (url, opts) => {
        if (typeof url === "string" && url.includes("paypal.com") && url.includes("/v1/oauth2/token")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: "mock-token", expires_in: 3600 }),
          };
        }
        if (typeof url === "string" && url.includes("paypal.com") && url.includes("/v1/notifications/verify-webhook-signature")) {
          const body = JSON.parse(opts.body);
          if (body.webhook_id === "WH-123456789" && body.transmission_id === "TX-1") {
            return {
              ok: true,
              status: 200,
              json: async () => ({ verification_status: "SUCCESS" }),
            };
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ verification_status: "FAILURE" }),
          };
        }
        return originalFetch(url, opts);
      };

      for (const eventType of ["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.DENIED", "CHECKOUT.ORDER.APPROVED"]) {
        const res = await fetch(`http://localhost:${port}/api/webhooks/paypal`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "paypal-auth-algo": "SHA256withRSA",
            "paypal-cert-url": "https://api.sandbox.paypal.com/v1/certs/1",
            "paypal-transmission-id": "TX-1",
            "paypal-transmission-sig": "SIG123",
            "paypal-transmission-time": "2024-01-01T00:00:00Z",
          },
          body: JSON.stringify({ event_type: eventType, resource: { id: "RES-1" } }),
        });
        assert.strictEqual(res.status, 200);
      }

      const resBad = await fetch(`http://localhost:${port}/api/webhooks/paypal`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "paypal-auth-algo": "SHA256withRSA",
          "paypal-cert-url": "https://api.sandbox.paypal.com/v1/certs/1",
          "paypal-transmission-id": "TX-INVALID",
          "paypal-transmission-sig": "SIG123",
          "paypal-transmission-time": "2024-01-01T00:00:00Z",
        },
        body: JSON.stringify({ event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "RES-1" } }),
      });
      assert.strictEqual(resBad.status, 400);
    } finally {
      global.fetch = originalFetch;
      server.close();
    }
  });

  it("server order creation calculates amount ignoring client total and verifies capture amount", async () => {
    const server = app.listen(0);
    const port = server.address().port;
    const originalFetch = global.fetch;

    try {
      let createdOrderAmount = null;

      global.fetch = async (url, opts) => {
        if (typeof url === "string" && url.includes("paypal.com") && url.includes("/v1/oauth2/token")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: "mock-token", expires_in: 3600 }),
          };
        }
        if (typeof url === "string" && url.includes("paypal.com") && url.includes("/v2/checkout/orders") && opts.method === "POST" && !url.includes("/capture")) {
          const body = JSON.parse(opts.body);
          createdOrderAmount = body.purchase_units[0].amount.value;
          return {
            ok: true,
            status: 201,
            json: async () => ({ id: "ORDER-TEST-1", status: "CREATED" }),
          };
        }
        if (typeof url === "string" && url.includes("paypal.com") && url.includes("/capture")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: "ORDER-TEST-1",
              status: "COMPLETED",
              purchase_units: [{
                payments: {
                  captures: [{ id: "CAP-1", status: "COMPLETED", amount: { value: "349.00" } }],
                },
              }],
            }),
          };
        }
        return originalFetch(url, opts);
      };

      const orderRes = await fetch(`http://localhost:${port}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [{ id: "ridgeline-2p-tent", qty: 1 }],
          total: "1.00",
        }),
      });
      assert.strictEqual(orderRes.status, 201);
      assert.strictEqual(createdOrderAmount, "349.00");

      const capRes = await fetch(`http://localhost:${port}/api/orders/ORDER-TEST-1/capture`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      assert.strictEqual(capRes.status, 200);
    } finally {
      global.fetch = originalFetch;
      server.close();
    }
  });

  it("server capture rejects amount mismatch", async () => {
    const server = app.listen(0);
    const port = server.address().port;
    const originalFetch = global.fetch;

    try {
      global.fetch = async (url, opts) => {
        if (typeof url === "string" && url.includes("paypal.com") && url.includes("/v1/oauth2/token")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: "mock-token", expires_in: 3600 }),
          };
        }
        if (typeof url === "string" && url.includes("paypal.com") && url.includes("/v2/checkout/orders") && opts.method === "POST" && !url.includes("/capture")) {
          return {
            ok: true,
            status: 201,
            json: async () => ({ id: "ORDER-TEST-2", status: "CREATED" }),
          };
        }
        if (typeof url === "string" && url.includes("paypal.com") && url.includes("/capture")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: "ORDER-TEST-2",
              status: "COMPLETED",
              purchase_units: [{
                payments: {
                  captures: [{ id: "CAP-2", status: "COMPLETED", amount: { value: "10.00" } }],
                },
              }],
            }),
          };
        }
        return originalFetch(url, opts);
      };

      const createRes = await fetch(`http://localhost:${port}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [{ id: "summit-65-pack", qty: 1 }],
        }),
      });
      assert.strictEqual(createRes.status, 201);

      const capRes = await fetch(`http://localhost:${port}/api/orders/ORDER-TEST-2/capture`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      assert.strictEqual(capRes.status, 400);
      const capJson = await capRes.json();
      assert.match(capJson.error, /does not match expected amount/);
    } finally {
      global.fetch = originalFetch;
      server.close();
    }
  });
});
