import { HttpError } from "./errors.mjs";
import { now } from "./clock.mjs";

/**
 * Fixed-window rate limiter middleware. Keyed by `x-api-key`, else by client IP.
 * @param {{ limit?: number, windowMs?: number, exempt?: (ctx) => boolean }} [options]
 */
export function rateLimit({ limit = 60, windowMs = 60_000, exempt = () => false } = {}) {
	const windows = new Map(); // key → { window, count }

	return async function rateLimitMiddleware(ctx, next) {
		if (exempt(ctx)) return next();
		const apiKey = ctx.req.headers["x-api-key"];
		const key = apiKey ? `key:${apiKey}` : `ip:${ctx.req.socket.remoteAddress}`;
		const t = now();
		const window = Math.floor(t / windowMs);
		let entry = windows.get(key);
		if (!entry || entry.window !== window) {
			entry = { window, count: 0 };
			windows.set(key, entry);
		}
		ctx.headers["X-RateLimit-Limit"] = String(limit);
		if (entry.count >= limit) {
			ctx.headers["X-RateLimit-Remaining"] = "0";
			const retryAfter = Math.ceil(((window + 1) * windowMs - t) / 1000);
			throw new HttpError(429, "RATE_LIMITED", "Too many requests", { "Retry-After": String(retryAfter) });
		}
		entry.count++;
		ctx.headers["X-RateLimit-Remaining"] = String(limit - entry.count);
		return next();
	};
}
