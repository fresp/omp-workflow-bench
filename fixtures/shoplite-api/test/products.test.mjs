import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "./helpers.mjs";

let app;
before(async () => (app = await startApp()));
after(() => app.close());

test("GET /products lists seeded products", async () => {
	const res = await app.request("/products");
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.length, 5);
});

test("GET /products?q= filters by name, case-insensitive", async () => {
	const body = await (await app.request("/products?q=BEANS")).json();
	assert.deepEqual(body.map((p) => p.name), ["Espresso Beans 1kg", "Decaf Beans 500g"]);
});

test("GET /products?category= filters by category", async () => {
	const body = await (await app.request("/products?category=equipment")).json();
	assert.equal(body.length, 3);
});

test("GET /products/:id 404s with the standard error body", async () => {
	const res = await app.request("/products/999");
	assert.equal(res.status, 404);
	assert.deepEqual(await res.json(), { error: { code: "NOT_FOUND", message: "Product 999 not found" } });
});

test("POST /products validates and creates", async () => {
	const bad = await app.request("/products", { method: "POST", body: { name: "", category: "x", priceCents: 1 } });
	assert.equal(bad.status, 400);
	assert.equal((await bad.json()).error.code, "VALIDATION_FAILED");
	const res = await app.request("/products", { method: "POST", body: { name: "Mug", category: "equipment", priceCents: 1200 } });
	assert.equal(res.status, 201);
	assert.equal((await res.json()).discountPercent, 0);
});
