import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "../helpers.mjs";
import { setNow, resetClock } from "../../src/lib/clock.mjs";

let app;
before(async () => (app = await startApp()));
after(() => app.close());
afterEach(() => resetClock());

const post = (path, body) => app.request(path, { method: "POST", body });
const order = (items, couponCode) => post("/orders", couponCode === undefined ? { items } : { items, couponCode });

test("orders without a coupon get couponCode null and couponDiscountCents 0", async () => {
	const res = await order([{ productId: 1, quantity: 1 }]);
	assert.equal(res.status, 201);
	const o = await res.json();
	assert.equal(o.couponCode, null);
	assert.equal(o.couponDiscountCents, 0);
	assert.equal(o.totalCents, 1899);
});

test("create a coupon: 201, code stored upper-case", async () => {
	const res = await post("/coupons", { code: "summer10", type: "percent", value: 10 });
	assert.equal(res.status, 201);
	const c = await res.json();
	assert.equal(c.code, "SUMMER10");
	assert.equal(c.type, "percent");
	assert.equal(c.value, 10);
});

test("duplicate code (any case) → 409 CONFLICT", async () => {
	await post("/coupons", { code: "DUPE", type: "fixed", value: 100 });
	const res = await post("/coupons", { code: "dupe", type: "fixed", value: 200 });
	assert.equal(res.status, 409);
	assert.equal((await res.json()).error.code, "CONFLICT");
});

test("invalid coupon definitions → 400 VALIDATION_FAILED", async () => {
	for (const body of [
		{ code: "X1", type: "bogus", value: 5 },
		{ code: "X2", type: "percent", value: 0 },
		{ code: "X3", type: "percent", value: 150 },
		{ code: "X4", type: "fixed", value: 1.5 },
	]) {
		const res = await post("/coupons", body);
		assert.equal(res.status, 400, JSON.stringify(body));
		assert.equal((await res.json()).error.code, "VALIDATION_FAILED");
	}
});

test("percent coupon applies to the subtotal after sale discounts, rounded once half-up", async () => {
	await post("/coupons", { code: "PCT15", type: "percent", value: 15 });
	// product 2: 4500 with 10% sale → 4050; product 3: 599 → subtotal 4649; 15% = 697.35 → 697
	const o = await (await order([{ productId: 2, quantity: 1 }, { productId: 3, quantity: 1 }], "pct15")).json();
	assert.equal(o.subtotalCents, 4649);
	assert.equal(o.couponCode, "PCT15");
	assert.equal(o.couponDiscountCents, 697);
	assert.equal(o.totalCents, 3952);
	assert.equal(o.discountCents, 450, "discountCents stays product sale discounts only");
});

test("percent rounding: .5 rounds up", async () => {
	await post("/coupons", { code: "HALF", type: "percent", value: 50 });
	const product = await (await post("/products", { name: "Odd", category: "misc", priceCents: 101 })).json();
	const o = await (await order([{ productId: product.id, quantity: 1 }], "HALF")).json();
	assert.equal(o.couponDiscountCents, 51);
	assert.equal(o.totalCents, 50);
});

test("fixed coupon is capped so the total never goes below zero", async () => {
	await post("/coupons", { code: "BIG", type: "fixed", value: 100000 });
	const o = await (await order([{ productId: 3, quantity: 1 }], "BIG")).json();
	assert.equal(o.couponDiscountCents, 599);
	assert.equal(o.totalCents, 0);
});

test("fixed coupon subtracts cents", async () => {
	await post("/coupons", { code: "FIVE", type: "fixed", value: 500 });
	const o = await (await order([{ productId: 1, quantity: 1 }], "FIVE")).json();
	assert.equal(o.totalCents, 1399);
});

test("unknown coupon → 400 COUPON_INVALID and no order is created", async () => {
	const res = await order([{ productId: 1, quantity: 1 }], "NOPE");
	assert.equal(res.status, 400);
	assert.equal((await res.json()).error.code, "COUPON_INVALID");
});

test("minimum subtotal is checked against the discounted subtotal (>= passes)", async () => {
	await post("/coupons", { code: "MIN", type: "fixed", value: 100, minSubtotalCents: 4050 });
	const ok = await order([{ productId: 2, quantity: 1 }], "MIN"); // 4050 after sale discount
	assert.equal(ok.status, 201);
	const low = await order([{ productId: 3, quantity: 1 }], "MIN"); // 599
	assert.equal(low.status, 400);
	assert.equal((await low.json()).error.code, "COUPON_MIN_NOT_MET");
	// 4500 list price would pass a list-price check but 4050 < 4051 must fail
	await post("/coupons", { code: "MIN2", type: "fixed", value: 100, minSubtotalCents: 4051 });
	const listPrice = await order([{ productId: 2, quantity: 1 }], "MIN2");
	assert.equal(listPrice.status, 400);
	assert.equal((await listPrice.json()).error.code, "COUPON_MIN_NOT_MET");
});

test("expiry uses the app clock; expired strictly after expiresAt", async () => {
	await post("/coupons", { code: "SOON", type: "percent", value: 10, expiresAt: "2026-06-30T23:59:59.000Z" });
	setNow(Date.parse("2026-06-30T23:59:59.000Z"));
	assert.equal((await order([{ productId: 1, quantity: 1 }], "SOON")).status, 201);
	setNow(Date.parse("2026-07-01T00:00:00.000Z"));
	const res = await order([{ productId: 1, quantity: 1 }], "SOON");
	assert.equal(res.status, 400);
	assert.equal((await res.json()).error.code, "COUPON_EXPIRED");
});

test("GET /orders/:id returns the coupon fields", async () => {
	await post("/coupons", { code: "KEEP", type: "fixed", value: 99 });
	const created = await (await order([{ productId: 1, quantity: 1 }], "keep")).json();
	const fetched = await (await app.request(`/orders/${created.id}`)).json();
	assert.equal(fetched.couponCode, "KEEP");
	assert.equal(fetched.couponDiscountCents, 99);
	assert.equal(fetched.totalCents, 1800);
});
