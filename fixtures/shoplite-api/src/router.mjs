// Minimal router: exact segments plus `:param` segments, and an onion-style middleware chain.
export function createRouter() {
	const routes = [];
	const middleware = [];

	function add(method, pattern, handler) {
		const parts = pattern.split("/").filter(Boolean);
		routes.push({ method, parts, handler, pattern });
	}

	function match(method, pathname) {
		const segs = pathname.split("/").filter(Boolean);
		for (const route of routes) {
			if (route.method !== method || route.parts.length !== segs.length) continue;
			const params = {};
			let ok = true;
			for (let i = 0; i < segs.length; i++) {
				const p = route.parts[i];
				if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(segs[i]);
				else if (p !== segs[i]) {
					ok = false;
					break;
				}
			}
			if (ok) return { route, params };
		}
		return null;
	}

	return {
		get: (p, h) => add("GET", p, h),
		post: (p, h) => add("POST", p, h),
		put: (p, h) => add("PUT", p, h),
		delete: (p, h) => add("DELETE", p, h),
		/** middleware: async (ctx, next) => {} — runs for every request, in registration order */
		use: (fn) => middleware.push(fn),
		match,
		middleware,
	};
}

export async function runChain(middleware, ctx, final) {
	let index = -1;
	async function dispatch(i) {
		if (i <= index) throw new Error("next() called twice");
		index = i;
		const fn = i === middleware.length ? final : middleware[i];
		if (!fn) return;
		await fn(ctx, () => dispatch(i + 1));
	}
	await dispatch(0);
}
