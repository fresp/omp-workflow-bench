import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "../helpers.mjs";
import { priceLine } from "../../src/services/pricing.mjs";

let app;
before(async () => (app = await startApp()));
after(() => app.close());

async function orderOf(priceCents, discountPercent, quantity) {
	const product = await (
		await app.request("/products", { method: "POST", body: { name: `P${priceCents}-${discountPercent}`, category: "misc", priceCents, discountPercent } })
	).json();
	return (await app.request("/orders", { method: "POST", body: { items: [{ productId: product.id, quantity }] } })).json();
}

test("the reported case: 4 × 1.99 at 25% off = 5.97", async () => {
	const o = await orderOf(199, 25, 4);
	assert.equal(o.totalCents, 597);
	assert.equal(o.lines[0].discountCents, 199);
	assert.equal(o.discountCents, 199);
});

test("half-up rounding happens once on the line total", async () => {
	const o = await orderOf(250, 33, 3); // 750 × 0.67 = 502.5 → 503
	assert.equal(o.totalCents, 503);
	assert.equal(o.lines[0].discountCents, 247);
});

test("pricing service applies the rule directly", () => {
	const line = priceLine({ id: 1, name: "x", priceCents: 199, discountPercent: 25 }, 4);
	assert.equal(line.totalCents, 597);
	assert.equal(line.grossCents, 796);
	assert.equal(line.discountCents + line.totalCents, line.grossCents);
});

test("many combinations match the README rule", () => {
	for (const price of [1, 99, 101, 199, 250, 333, 999, 1899]) {
		for (const pct of [0, 5, 10, 15, 25, 33, 50, 99, 100]) {
			for (const qty of [1, 2, 3, 7]) {
				const expected = Math.floor((price * qty * (100 - pct)) / 100 + 0.5);
				const line = priceLine({ id: 1, name: "x", priceCents: price, discountPercent: pct }, qty);
				assert.equal(line.totalCents, expected, `${qty} × ${price} @ ${pct}%`);
				assert.equal(line.discountCents, price * qty - expected);
			}
		}
	}
});

test("undiscounted and single-quantity orders are unchanged", async () => {
	assert.equal((await orderOf(1899, 0, 3)).totalCents, 5697);
	assert.equal((await orderOf(4500, 10, 1)).totalCents, 4050);
});
