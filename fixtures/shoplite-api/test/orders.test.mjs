import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "./helpers.mjs";

let app;
before(async () => (app = await startApp()));
after(() => app.close());

test("POST /orders prices lines in integer cents", async () => {
	const res = await app.request("/orders", { method: "POST", body: { items: [{ productId: 1, quantity: 2 }] } });
	assert.equal(res.status, 201);
	const order = await res.json();
	assert.equal(order.subtotalCents, 3798);
	assert.equal(order.totalCents, 3798);
});

test("POST /orders applies a product's sale discount", async () => {
	const res = await app.request("/orders", { method: "POST", body: { items: [{ productId: 2, quantity: 1 }] } });
	const order = await res.json();
	assert.equal(order.lines[0].totalCents, 4050);
	assert.equal(order.discountCents, 450);
});

test("POST /orders rejects unknown products and bad quantities", async () => {
	const unknown = await app.request("/orders", { method: "POST", body: { items: [{ productId: 42, quantity: 1 }] } });
	assert.equal(unknown.status, 404);
	const badQty = await app.request("/orders", { method: "POST", body: { items: [{ productId: 1, quantity: 0 }] } });
	assert.equal(badQty.status, 400);
});

test("GET /orders/:id returns a saved order", async () => {
	const created = await (await app.request("/orders", { method: "POST", body: { items: [{ productId: 3, quantity: 1 }] } })).json();
	const res = await app.request(`/orders/${created.id}`);
	assert.equal(res.status, 200);
	assert.equal((await res.json()).totalCents, 599);
});
