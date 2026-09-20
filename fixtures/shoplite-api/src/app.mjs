import { createRouter, runChain } from "./router.mjs";
import { HttpError, errorBody, notFound } from "./lib/errors.mjs";
import { readJson, sendJson } from "./lib/http.mjs";
import { createStore } from "./store/memory-store.mjs";
import { seedProducts } from "./store/seed.mjs";
import * as health from "./routes/health.mjs";
import * as products from "./routes/products.mjs";
import * as orders from "./routes/orders.mjs";

/**
 * @param {{ store?: ReturnType<typeof createStore>, logger?: { error: Function } }} [options]
 */
export function createApp(options = {}) {
	const store = options.store ?? createStore({ products: seedProducts });
	const logger = options.logger ?? console;
	const router = createRouter();

	const deps = { store };
	health.register(router, deps);
	products.register(router, deps);
	orders.register(router, deps);

	async function handle(req, res) {
		const url = new URL(req.url, "http://localhost");
		const ctx = {
			req,
			res,
			method: req.method,
			path: url.pathname,
			query: url.searchParams,
			params: {},
			body: undefined,
			status: 200,
			headers: {},
			result: undefined,
		};
		try {
			await runChain(router.middleware, ctx, async () => {
				const found = router.match(req.method, url.pathname);
				if (!found) throw notFound(`Route ${req.method} ${url.pathname}`);
				ctx.params = found.params;
				if (req.method === "POST" || req.method === "PUT") ctx.body = await readJson(req);
				await found.route.handler(ctx);
			});
			sendJson(res, ctx.status, ctx.result ?? null, ctx.headers);
		} catch (err) {
			if (err instanceof HttpError) {
				sendJson(res, err.status, errorBody(err), { ...ctx.headers, ...err.headers });
			} else {
				logger.error(err);
				sendJson(res, 500, { error: { code: "INTERNAL", message: "Internal server error" } });
			}
		}
	}

	return { handle, store, router };
}
