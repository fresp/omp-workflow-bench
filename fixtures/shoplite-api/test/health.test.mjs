import { test } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "./helpers.mjs";

test("GET /health", async () => {
	const app = await startApp();
	try {
		const res = await app.request("/health");
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { status: "ok" });
	} finally {
		await app.close();
	}
});
