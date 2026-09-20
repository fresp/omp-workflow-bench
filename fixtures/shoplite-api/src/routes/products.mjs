import { notFound } from "../lib/errors.mjs";
import { requireString, requireInt, optionalInt } from "../lib/validate.mjs";

export function register(router, { store }) {
	router.get("/products", async (ctx) => {
		let items = store.listProducts();
		const q = ctx.query.get("q");
		if (q) {
			const needle = q.toLowerCase();
			items = items.filter((p) => p.name.toLowerCase().includes(needle));
		}
		const category = ctx.query.get("category");
		if (category) items = items.filter((p) => p.category === category);
		ctx.result = items;
	});

	router.get("/products/:id", async (ctx) => {
		const product = store.getProduct(Number(ctx.params.id));
		if (!product) throw notFound(`Product ${ctx.params.id}`);
		ctx.result = product;
	});

	router.post("/products", async (ctx) => {
		const body = ctx.body ?? {};
		const product = store.addProduct({
			name: requireString(body.name, "name"),
			category: requireString(body.category, "category"),
			priceCents: requireInt(body.priceCents, "priceCents", { min: 0 }),
			discountPercent: optionalInt(body.discountPercent, "discountPercent", { min: 0, max: 100 }) ?? 0,
		});
		ctx.status = 201;
		ctx.result = product;
	});
}
