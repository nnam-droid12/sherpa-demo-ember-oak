const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");

const app = require("../server.js");

describe("PayPal Cart API v1 & Catalog Feed", () => {
  let server;
  let baseUrl;
  let originalFetch;
  let mockOrders;
  let orderCounter;

  beforeEach(async () => {
    originalFetch = global.fetch;
    mockOrders = new Map();
    orderCounter = 1;

    // Mock PayPal API calls
    global.fetch = async (url, opts = {}) => {
      const urlStr = typeof url === "string" ? url : url.toString();

      if (urlStr.includes("paypal.com")) {
        // OAuth token
        if (urlStr.includes("/v1/oauth2/token")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: "mock-cart-token", expires_in: 3600 }),
          };
        }

        // Create order
        if (urlStr.includes("/v2/checkout/orders") && opts.method === "POST" && !urlStr.includes("/capture")) {
          const body = JSON.parse(opts.body || "{}");
          const orderId = `ORDER-MOCK-${orderCounter++}`;
          const orderObj = {
            id: orderId,
            status: "CREATED",
            intent: body.intent || "CAPTURE",
            purchase_units: body.purchase_units || [],
            payment_source: body.payment_source || {},
          };
          mockOrders.set(orderId, orderObj);
          return {
            ok: true,
            status: 201,
            json: async () => orderObj,
          };
        }

        // Capture order
        if (urlStr.includes("/capture") && opts.method === "POST") {
          const match = urlStr.match(/\/v2\/checkout\/orders\/([^/]+)\/capture/);
          const orderId = match ? match[1] : "UNKNOWN";
          const order = mockOrders.get(orderId) || { purchase_units: [{ amount: { value: "349.00" } }] };
          const amountValue = order.purchase_units?.[0]?.amount?.value || "349.00";
          order.status = "COMPLETED";

          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: orderId,
              status: "COMPLETED",
              purchase_units: [
                {
                  payments: {
                    captures: [
                      {
                        id: `CAP-${orderId}`,
                        status: "COMPLETED",
                        amount: { currency_code: "USD", value: amountValue },
                      },
                    ],
                  },
                },
              ],
            }),
          };
        }

        // Get order
        if (urlStr.includes("/v2/checkout/orders/") && (!opts.method || opts.method === "GET")) {
          const match = urlStr.match(/\/v2\/checkout\/orders\/([^/]+)/);
          const orderId = match ? match[1] : "UNKNOWN";
          const order = mockOrders.get(orderId);
          if (!order) {
            return {
              ok: false,
              status: 404,
              json: async () => ({ name: "RESOURCE_NOT_FOUND", message: "Order not found" }),
            };
          }
          return {
            ok: true,
            status: 200,
            json: async () => order,
          };
        }
      }

      return originalFetch(url, opts);
    };

    server = app.listen(0);
    baseUrl = `http://localhost:${server.address().port}`;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (server) {
      server.close();
    }
  });

  it("GET /catalog.json returns items built from real product data with required agent fields", async () => {
    const res = await fetch(`${baseUrl}/catalog.json`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();

    assert.ok(Array.isArray(data.items), "catalog.json should return { items: [...] }");
    assert.strictEqual(data.items.length, 6);

    for (const item of data.items) {
      assert.ok(item.id, "item must have id");
      assert.ok(item.title, "item must have title");
      assert.ok(item.description, "item must have description");
      assert.ok(item.price && item.price.currency_code === "USD", "item price must have currency_code USD");
      assert.ok(typeof item.price.value === "string" && !isNaN(Number(item.price.value)), "item price must have string value");
      assert.ok(
        item.availability === "in_stock" || item.availability === "preorder",
        `item availability must be in_stock or preorder, got: ${item.availability}`
      );
      assert.ok(item.image_url.startsWith("http://"), `image_url must be absolute URL: ${item.image_url}`);
      assert.ok(item.url.startsWith("http://"), `url must be absolute URL: ${item.url}`);
      assert.ok(Array.isArray(item.variants), "item must have variants array");
      assert.ok(item.lead_time, "item must have lead_time fact");
      assert.ok(typeof item.lead_time_days === "number", "item must have lead_time_days");
    }

    const preorderItem = data.items.find((i) => i.id === "cinder-down-bag");
    assert.ok(preorderItem, "cinder-down-bag should be in catalog");
    assert.strictEqual(preorderItem.availability, "preorder");
    assert.strictEqual(preorderItem.lead_time_days, 3);
  });

  it("POST /merchant-cart creates cart, calculates catalog prices, validates, and creates PayPal order", async () => {
    const reqBody = {
      items: [{ item_id: "ridgeline-2p-tent", quantity: 1, price: "1.00" }], // client price should be ignored
      customer: { email_address: "buyer@example.com", name: { given_name: "Alex", surname: "Rivera" } },
      shipping_address: {
        address_line_1: "500 Market St",
        admin_area_2: "San Francisco",
        admin_area_1: "CA",
        postal_code: "94105",
        country_code: "US",
      },
      payment_method: { type: "paypal" },
    };

    const res = await fetch(`${baseUrl}/merchant-cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqBody),
    });

    assert.strictEqual(res.status, 201);
    const cart = await res.json();

    assert.ok(cart.id && cart.id.startsWith("cart_"), "cart id should start with cart_");
    assert.strictEqual(cart.status, "CREATED");
    assert.strictEqual(cart.validation_status, "VALID");
    assert.deepStrictEqual(cart.validation_issues, []);
    assert.strictEqual(cart.items[0].item_id, "ridgeline-2p-tent");
    assert.strictEqual(cart.items[0].name, "Ridgeline 2P Alpine Tent");
    assert.strictEqual(cart.items[0].price.value, "349.00"); // ignored client price "1.00"
    assert.strictEqual(cart.totals.subtotal.value, "349.00");
    assert.strictEqual(cart.totals.total.value, "349.00");
    assert.strictEqual(cart.payment_method.type, "paypal");
    assert.ok(cart.payment_method.token, "payment_method.token must be set to PayPal order id");

    // Verify created PayPal order has experience_context
    const createdOrder = mockOrders.get(cart.payment_method.token);
    assert.ok(createdOrder, "PayPal order should have been created in mock");
    const expContext = createdOrder.payment_source?.paypal?.experience_context;
    assert.ok(expContext, "experience_context must be present");
    assert.strictEqual(expContext.user_action, "PAY_NOW");
    assert.ok(expContext.return_url.endsWith("/thank-you"));
    assert.ok(expContext.cancel_url.endsWith("/cart"));
  });

  it("GET /merchant-cart/{id} reads stored cart and returns 404 for unknown id", async () => {
    // 404 check
    const resNotFound = await fetch(`${baseUrl}/merchant-cart/cart_nonexistent`);
    assert.strictEqual(resNotFound.status, 404);
    const errBody = await resNotFound.json();
    assert.strictEqual(errBody.name, "CART_NOT_FOUND");
    assert.ok(errBody.message);
    assert.ok(errBody.debug_id);

    // Create a cart then fetch it
    const createRes = await fetch(`${baseUrl}/merchant-cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ item_id: "trailmark-headlamp", quantity: 2 }],
        shipping_address: {
          address_line_1: "123 Trail Rd",
          admin_area_2: "Bend",
          admin_area_1: "OR",
          postal_code: "97701",
          country_code: "US",
        },
      }),
    });
    const created = await createRes.json();

    const getRes = await fetch(`${baseUrl}/merchant-cart/${created.id}`);
    assert.strictEqual(getRes.status, 200);
    const fetched = await getRes.json();
    assert.strictEqual(fetched.id, created.id);
    assert.strictEqual(fetched.totals.total.value, "78.00");
  });

  it("PUT /merchant-cart/{id} replaces the whole cart (clearing omitted fields) and updates order amount", async () => {
    // 1. Create cart with shipping address and ridgeline-2p-tent ($349)
    const createRes = await fetch(`${baseUrl}/merchant-cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ item_id: "ridgeline-2p-tent", quantity: 1 }],
        shipping_address: {
          address_line_1: "500 Market St",
          admin_area_2: "San Francisco",
          admin_area_1: "CA",
          postal_code: "94105",
          country_code: "US",
        },
      }),
    });
    const initialCart = await createRes.json();
    assert.strictEqual(initialCart.totals.total.value, "349.00");
    assert.strictEqual(initialCart.validation_status, "VALID");
    const initialToken = initialCart.payment_method.token;

    // 2. PUT with kindle-camp-stove ($89) and OMIT shipping_address
    const putRes = await fetch(`${baseUrl}/merchant-cart/${initialCart.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ item_id: "kindle-camp-stove", quantity: 1 }],
      }),
    });
    assert.strictEqual(putRes.status, 200);
    const updatedCart = await putRes.json();

    assert.strictEqual(updatedCart.id, initialCart.id);
    assert.strictEqual(updatedCart.items[0].item_id, "kindle-camp-stove");
    assert.strictEqual(updatedCart.totals.total.value, "89.00");
    // Omitted shipping address is cleared, resulting in validation issues
    assert.strictEqual(updatedCart.shipping_address, undefined);
    assert.strictEqual(updatedCart.status, "INCOMPLETE");
    assert.strictEqual(updatedCart.validation_status, "INVALID");
    assert.ok(updatedCart.validation_issues.some((iss) => iss.code === "SHIPPING_ERROR"));

    // Verify PayPal order was recreated with new amount
    assert.notStrictEqual(updatedCart.payment_method.token, initialToken);
    const recreatedOrder = mockOrders.get(updatedCart.payment_method.token);
    assert.strictEqual(recreatedOrder.purchase_units[0].amount.value, "89.00");

    // PUT with unknown id returns 404
    const putNotFound = await fetch(`${baseUrl}/merchant-cart/cart_unknown`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [] }),
    });
    assert.strictEqual(putNotFound.status, 404);
  });

  it("validates unknown item_id with INVENTORY_ISSUE and missing shipping_address with SHIPPING_ERROR", async () => {
    const res = await fetch(`${baseUrl}/merchant-cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ item_id: "unknown-item-123", quantity: 1 }],
      }),
    });
    assert.strictEqual(res.status, 201);
    const cart = await res.json();

    assert.strictEqual(cart.validation_status, "INVALID");

    const invIssue = cart.validation_issues.find((iss) => iss.code === "INVENTORY_ISSUE");
    assert.ok(invIssue, "Cart should have INVENTORY_ISSUE for unknown item");
    assert.strictEqual(invIssue.type, "INVALID_DATA");

    const shipIssue = cart.validation_issues.find((iss) => iss.code === "SHIPPING_ERROR");
    assert.ok(shipIssue, "Cart should have SHIPPING_ERROR for missing shipping address");
    assert.strictEqual(shipIssue.type, "MISSING_FIELD");
    assert.strictEqual(shipIssue.field, "shipping_address");
    assert.deepStrictEqual(shipIssue.resolution_options, [{ action: "PROVIDE_MISSING_FIELD" }]);
  });

  it("validates preorder products requiring DELIVERY_DATE_PREFERENCE checkout field", async () => {
    const shipping = {
      address_line_1: "500 Market St",
      admin_area_2: "San Francisco",
      admin_area_1: "CA",
      postal_code: "94105",
      country_code: "US",
    };

    // Case 1: Preorder item with missing DELIVERY_DATE_PREFERENCE
    const resMissing = await fetch(`${baseUrl}/merchant-cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ item_id: "cinder-down-bag", quantity: 1 }],
        shipping_address: shipping,
      }),
    });
    assert.strictEqual(resMissing.status, 201);
    const cartMissing = await resMissing.json();

    assert.strictEqual(cartMissing.validation_status, "INVALID");
    const dateIssueMissing = cartMissing.validation_issues.find(
      (iss) => iss.field === "checkout_fields.DELIVERY_DATE_PREFERENCE"
    );
    assert.ok(dateIssueMissing, "Cart must flag missing DELIVERY_DATE_PREFERENCE");
    assert.strictEqual(dateIssueMissing.code, "DATA_ERROR");
    assert.strictEqual(dateIssueMissing.type, "MISSING_FIELD");
    assert.deepStrictEqual(dateIssueMissing.resolution_options, [{ action: "PROVIDE_MISSING_FIELD" }]);

    // Case 2: Preorder item with too-early DELIVERY_DATE_PREFERENCE (e.g. yesterday or tomorrow)
    const resTooEarly = await fetch(`${baseUrl}/merchant-cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ item_id: "cinder-down-bag", quantity: 1 }],
        shipping_address: shipping,
        checkout_fields: [{ type: "DELIVERY_DATE_PREFERENCE", value: "2020-01-01" }],
      }),
    });
    const cartTooEarly = await resTooEarly.json();

    assert.strictEqual(cartTooEarly.validation_status, "INVALID");
    const dateIssueEarly = cartTooEarly.validation_issues.find(
      (iss) => iss.field === "checkout_fields.DELIVERY_DATE_PREFERENCE"
    );
    assert.ok(dateIssueEarly, "Cart must flag too-early DELIVERY_DATE_PREFERENCE");
    assert.strictEqual(dateIssueEarly.code, "DATA_ERROR");
    assert.deepStrictEqual(dateIssueEarly.resolution_options, [{ action: "PROVIDE_MISSING_FIELD" }]);

    // Case 3: Preorder item with valid delivery date (e.g. 2028-11-07)
    const resValid = await fetch(`${baseUrl}/merchant-cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ item_id: "cinder-down-bag", quantity: 1 }],
        shipping_address: shipping,
        checkout_fields: [{ type: "DELIVERY_DATE_PREFERENCE", value: "2028-11-07" }],
      }),
    });
    const cartValid = await resValid.json();
    assert.strictEqual(cartValid.validation_status, "VALID");
    assert.deepStrictEqual(cartValid.validation_issues, []);
  });

  it("POST /merchant-cart/{id}/checkout handles invalid cart and unapproved orders", async () => {
    // 0. Checkout on unknown cart returns 404
    const checkoutNotFoundRes = await fetch(`${baseUrl}/merchant-cart/cart_unknown/checkout`, {
      method: "POST",
    });
    assert.strictEqual(checkoutNotFoundRes.status, 404);
    const notFoundErr = await checkoutNotFoundRes.json();
    assert.strictEqual(notFoundErr.name, "CART_NOT_FOUND");
    assert.ok(notFoundErr.debug_id);

    // 1. Checkout on INVALID cart returns 200 with cart and issues
    const createInvalid = await fetch(`${baseUrl}/merchant-cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ item_id: "ridgeline-2p-tent", quantity: 1 }],
        // Missing shipping address
      }),
    });
    const invalidCart = await createInvalid.json();
    assert.strictEqual(invalidCart.validation_status, "INVALID");

    const checkoutInvalidRes = await fetch(`${baseUrl}/merchant-cart/${invalidCart.id}/checkout`, {
      method: "POST",
    });
    assert.strictEqual(checkoutInvalidRes.status, 200);
    const checkoutInvalidCart = await checkoutInvalidRes.json();
    assert.strictEqual(checkoutInvalidCart.id, invalidCart.id);
    assert.strictEqual(checkoutInvalidCart.validation_status, "INVALID");
    assert.ok(checkoutInvalidCart.validation_issues.length > 0);

    // 2. Checkout on VALID cart before buyer approves PayPal payment returns 422 UNPROCESSABLE_ENTITY
    const createValid = await fetch(`${baseUrl}/merchant-cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ item_id: "summit-65-pack", quantity: 1 }],
        shipping_address: {
          address_line_1: "500 Market St",
          admin_area_2: "San Francisco",
          admin_area_1: "CA",
          postal_code: "94105",
          country_code: "US",
        },
      }),
    });
    const validCart = await createValid.json();
    assert.strictEqual(validCart.validation_status, "VALID");

    // The mock order is in status "CREATED", not "APPROVED"
    const checkoutUnapprovedRes = await fetch(`${baseUrl}/merchant-cart/${validCart.id}/checkout`, {
      method: "POST",
    });
    assert.strictEqual(checkoutUnapprovedRes.status, 422);
    const unapprovedErr = await checkoutUnapprovedRes.json();
    assert.strictEqual(unapprovedErr.name, "UNPROCESSABLE_ENTITY");
    assert.match(unapprovedErr.message, /approve the PayPal payment/i);
    assert.ok(unapprovedErr.debug_id);

    // 3. Checkout once buyer has approved PayPal order captures and returns COMPLETED
    const mockOrder = mockOrders.get(validCart.payment_method.token);
    assert.ok(mockOrder);
    mockOrder.status = "APPROVED"; // simulate buyer approval

    const checkoutApprovedRes = await fetch(`${baseUrl}/merchant-cart/${validCart.id}/checkout`, {
      method: "POST",
    });
    assert.strictEqual(checkoutApprovedRes.status, 200);
    const completedCart = await checkoutApprovedRes.json();

    assert.strictEqual(completedCart.status, "COMPLETED");
    assert.ok(completedCart.payment_confirmation, "payment_confirmation must be present");
    assert.ok(completedCart.payment_confirmation.merchant_order_number);
    assert.ok(completedCart.payment_confirmation.order_review_page.includes("/thank-you?order="));
  });
});
