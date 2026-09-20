import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "../helpers.mjs";
import { setNow, resetClock } from "../../src/lib/clock.mjs";

afterEach(() => resetClock());

const WINDOW_START = Date.parse("2026-05-01T10:00:00.000Z"); // aligned to a 60 s boundary

async function withApp(fn) {
	const app = await startApp();
	try {
		await fn(app);
	} finally {
		await app.close();
	}
}

const hit = (app, key, path = "/products") => app.request(path, { headers: key ? { "x-api-key": key } : {} });

async function burn(app, key, n, path) {
	let last;
	for (let i = 0; i < n; i++) {
		last = await hit(app, key, path);
		await last.arrayBuffer();
	}
	return last;
}

test("60 requests per window are allowed, the 61st gets 429 RATE_LIMITED", async () => {
	setNow(WINDOW_START + 1000);
	await withApp(async (app) => {
		const sixtieth = await burn(app, "partner-a", 60);
		assert.equal(sixtieth.status, 200);
		const res = await hit(app, "partner-a");
		assert.equal(res.status, 429);
		assert.equal((await res.json()).error.code, "RATE_LIMITED");
	});
});

test("Retry-After is the whole seconds until the window ends, rounded up", async () => {
	setNow(WINDOW_START + 15_500); // 44.5 s left → 45
	await withApp(async (app) => {
		await burn(app, "partner-b", 60);
		const res = await hit(app, "partner-b");
		assert.equal(res.status, 429);
		assert.equal(res.headers.get("retry-after"), "45");
		await res.arrayBuffer();
	});
});

test("limit headers on every limited response", async () => {
	setNow(WINDOW_START);
	await withApp(async (app) => {
		const first = await hit(app, "partner-c");
		assert.equal(first.headers.get("x-ratelimit-limit"), "60");
		assert.equal(first.headers.get("x-ratelimit-remaining"), "59");
		await first.arrayBuffer();
		const last = await burn(app, "partner-c", 59);
		assert.equal(last.headers.get("x-ratelimit-remaining"), "0");
		const rejected = await hit(app, "partner-c");
		assert.equal(rejected.status, 429);
		assert.equal(rejected.headers.get("x-ratelimit-remaining"), "0");
		await rejected.arrayBuffer();
	});
});

test("keys are limited independently", async () => {
	setNow(WINDOW_START);
	await withApp(async (app) => {
		await burn(app, "key-1", 61);
		const other = await hit(app, "key-2");
		assert.equal(other.status, 200);
		await other.arrayBuffer();
	});
});

test("requests without a key are limited per client IP", async () => {
	setNow(WINDOW_START);
	await withApp(async (app) => {
		const sixtieth = await burn(app, null, 60);
		assert.equal(sixtieth.status, 200);
		const res = await hit(app, null);
		assert.equal(res.status, 429);
		await res.arrayBuffer();
		// a keyed partner coming from the same IP is not affected
		const keyed = await hit(app, "partner-d");
		assert.equal(keyed.status, 200);
		await keyed.arrayBuffer();
	});
});

test("GET /health is never limited", async () => {
	setNow(WINDOW_START);
	await withApp(async (app) => {
		const last = await burn(app, "lb", 100, "/health");
		assert.equal(last.status, 200);
	});
});

test("POST routes are limited too", async () => {
	setNow(WINDOW_START);
	await withApp(async (app) => {
		for (let i = 0; i < 60; i++) {
			const r = await app.request("/orders", { method: "POST", headers: { "x-api-key": "poster" }, body: { items: [{ productId: 1, quantity: 1 }] } });
			await r.arrayBuffer();
		}
		const res = await app.request("/orders", { method: "POST", headers: { "x-api-key": "poster" }, body: { items: [{ productId: 1, quantity: 1 }] } });
		assert.equal(res.status, 429);
		await res.arrayBuffer();
	});
});

test("the window is fixed and aligned to the clock: a new minute resets the quota", async () => {
	setNow(WINDOW_START + 59_000);
	await withApp(async (app) => {
		await burn(app, "partner-e", 60);
		assert.equal((await hit(app, "partner-e")).status, 429);
		setNow(WINDOW_START + 60_000); // next aligned window, only 1 s later
		const res = await hit(app, "partner-e");
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("x-ratelimit-remaining"), "59");
		await res.arrayBuffer();
	});
});

test("rejected requests do not consume the next window's quota or extend the window", async () => {
	setNow(WINDOW_START + 30_000);
	await withApp(async (app) => {
		await burn(app, "partner-f", 70);
		setNow(WINDOW_START + 60_000);
		const res = await hit(app, "partner-f");
		assert.equal(res.headers.get("x-ratelimit-remaining"), "59");
		await res.arrayBuffer();
	});
});
