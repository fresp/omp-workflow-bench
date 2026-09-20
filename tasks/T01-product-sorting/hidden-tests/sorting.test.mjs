import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "../helpers.mjs";

let app;
before(async () => {
	app = await startApp();
	// a tie on price with an earlier product, and a lowercase name
	await app.request("/products", { method: "POST", body: { name: "Filter Holder", category: "equipment", priceCents: 599 } });
});
after(() => app.close());

const names = async (path) => (await (await app.request(path)).json()).map((p) => p.name);

test("price_asc orders by priceCents, ties by creation order", async () => {
	assert.deepEqual(await names("/products?sort=price_asc"), [
		"Paper Filters (100)",
		"Filter Holder",
		"Decaf Beans 500g",
		"Espresso Beans 1kg",
		"ceramic Dripper",
		"Pour-over Kettle",
	]);
});

test("price_desc orders by priceCents descending, ties by creation order", async () => {
	assert.deepEqual(await names("/products?sort=price_desc"), [
		"Pour-over Kettle",
		"ceramic Dripper",
		"Espresso Beans 1kg",
		"Decaf Beans 500g",
		"Paper Filters (100)",
		"Filter Holder",
	]);
});

test("name sorts case-insensitively", async () => {
	assert.deepEqual(await names("/products?sort=name"), [
		"ceramic Dripper",
		"Decaf Beans 500g",
		"Espresso Beans 1kg",
		"Filter Holder",
		"Paper Filters (100)",
		"Pour-over Kettle",
	]);
});

test("sort composes with category and q filters", async () => {
	assert.deepEqual(await names("/products?category=coffee&sort=price_asc"), ["Decaf Beans 500g", "Espresso Beans 1kg"]);
	assert.deepEqual(await names("/products?q=filter&sort=name"), ["Filter Holder", "Paper Filters (100)"]);
});

test("no sort keeps creation order", async () => {
	const list = await (await app.request("/products")).json();
	assert.deepEqual(list.map((p) => p.id), [1, 2, 3, 4, 5, 6]);
});

test("empty sort= is the default order", async () => {
	const list = await (await app.request("/products?sort=")).json();
	assert.deepEqual(list.map((p) => p.id), [1, 2, 3, 4, 5, 6]);
});

test("unknown sort value → 400 INVALID_QUERY", async () => {
	for (const value of ["price", "PRICE_ASC", "random"]) {
		const res = await app.request(`/products?sort=${value}`);
		assert.equal(res.status, 400, value);
		const body = await res.json();
		assert.equal(body.error.code, "INVALID_QUERY");
		assert.equal(typeof body.error.message, "string");
	}
});
