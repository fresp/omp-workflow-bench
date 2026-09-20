import { badRequest, notFound } from "../lib/errors.mjs";
import { requireString, requireInt, optionalInt } from "../lib/validate.mjs";

const SORTS = {
	price_asc: (a, b) => a.priceCents - b.priceCents,
	price_desc: (a, b) => b.priceCents - a.priceCents,
	name: (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
};

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
		const sort = ctx.query.get("sort");
		if (sort) {
			const compare = SORTS[sort];
			if (!compare) throw badRequest(`sort must be one of ${Object.keys(SORTS).join(", ")}`, "INVALID_QUERY");
			items = [...items].sort((a, b) => compare(a, b) || a.id - b.id);
		}
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
