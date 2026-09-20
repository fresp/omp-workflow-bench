import { now } from "../lib/clock.mjs";

/**
 * In-memory store. Ids are sequential integers per collection.
 * @param {{ products?: Array<object> }} [seed]
 */
export function createStore(seed = {}) {
	const products = new Map();
	const orders = new Map();
	const coupons = new Map();
	const counters = { product: 0, order: 0 };

	const store = {
		listProducts() {
			return [...products.values()];
		},
		getProduct(id) {
			return products.get(id) ?? null;
		},
		addProduct(input) {
			const product = { id: ++counters.product, discountPercent: 0, ...input, createdAt: new Date(now()).toISOString() };
			products.set(product.id, product);
			return product;
		},
		addOrder(order) {
			const saved = { id: ++counters.order, ...order, createdAt: new Date(now()).toISOString() };
			orders.set(saved.id, saved);
			return saved;
		},
		getCoupon(code) {
			return coupons.get(String(code).toUpperCase()) ?? null;
		},
		addCoupon(coupon) {
			const saved = { ...coupon, code: coupon.code.toUpperCase() };
			coupons.set(saved.code, saved);
			return saved;
		},
		getOrder(id) {
			return orders.get(id) ?? null;
		},
	};

	for (const p of seed.products ?? []) store.addProduct(p);
	return store;
}
