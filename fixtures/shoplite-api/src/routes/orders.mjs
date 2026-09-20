import { badRequest, notFound } from "../lib/errors.mjs";
import { requireInt } from "../lib/validate.mjs";
import { priceLine, priceOrder } from "../services/pricing.mjs";

export function register(router, { store }) {
	router.post("/orders", async (ctx) => {
		const items = ctx.body?.items;
		if (!Array.isArray(items) || items.length === 0) {
			throw badRequest("items must be a non-empty array", "VALIDATION_FAILED");
		}
		const lines = items.map((item, i) => {
			const productId = requireInt(item?.productId, `items[${i}].productId`, { min: 1 });
			const quantity = requireInt(item?.quantity, `items[${i}].quantity`, { min: 1, max: 999 });
			const product = store.getProduct(productId);
			if (!product) throw notFound(`Product ${productId}`);
			return priceLine(product, quantity);
		});
		const order = store.addOrder(priceOrder(lines));
		ctx.status = 201;
		ctx.result = order;
	});

	router.get("/orders/:id", async (ctx) => {
		const order = store.getOrder(Number(ctx.params.id));
		if (!order) throw notFound(`Order ${ctx.params.id}`);
		ctx.result = order;
	});
}
