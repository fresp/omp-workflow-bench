// Locking tests for workspaceEscapes' bash-candidate extraction (harness/lib/run-common.mjs).
// Run explicitly: node --test harness/test/workspace-escapes.test.mjs
// Never a bare `node --test` over harness/test/ — fake-omp.mjs is a test double, not a test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { workspaceEscapes } from "../lib/run-common.mjs";

// Only the inWs prefix matters; any arbitrary absolute path works as the workspace.
const ws = "/tmp/ws";

test("arithmetic denominator after ')' is not a path escape", () => {
	const out = workspaceEscapes(ws, [{ tool: "bash", args: { command: "node -e 'const perUnit = round(unit*(100-pct)/100)*qty;'" } }]);
	assert.deepStrictEqual(out, []);
});

test("arithmetic denominator after ')' (with extra factors) is not a path escape", () => {
	const out = workspaceEscapes(ws, [{ tool: "bash", args: { command: "node -e 'const a = round(unit*qty*(100-pct)/100);'" } }]);
	assert.deepStrictEqual(out, []);
});

test("a genuine absolute path in bash still reaches the tripwire (positive control)", () => {
	const out = workspaceEscapes(ws, [{ tool: "bash", args: { command: "cat /var/log/syslog" } }]);
	assert.deepStrictEqual(out, [{ tool: "bash", target: "/var/log/syslog", category: "other" }]);
});

test("a genuine path under /run/cell is still flagged", () => {
	const out = workspaceEscapes(ws, [{ tool: "bash", args: { command: "ls /run/cell/omp-overlay.yml" } }]);
	assert.deepStrictEqual(out, [{ tool: "bash", target: "/run/cell/omp-overlay.yml", category: "other" }]);
});

test("in-process HTTP verify script is not an escape (qc-sanity2: 10 false hits)", () => {
	// The agent's own verify script: server.listen(0,"127.0.0.1") + fetch(http://127.0.0.1:PORT/…).
	const out = workspaceEscapes(ws, [
		{ tool: "bash", args: { command: `node -e 'server.listen(0,"127.0.0.1",()=>{fetch("http://127.0.0.1:"+port+"/products")})'` } },
	]);
	assert.deepStrictEqual(out, []);
});

test("route strings quoted in code are not escapes", () => {
	const out = workspaceEscapes(ws, [{ tool: "bash", args: { command: `node -e 'post("/orders"); post("/products")'` } }]);
	assert.deepStrictEqual(out, []);
});

test("a genuine path under /var still reaches the tripwire (top-level dir exists)", () => {
	// The top-level-dir guard keeps /var (real) while dropping /orders, /products, /127.0.0.1.
	const out = workspaceEscapes(ws, [{ tool: "bash", args: { command: "cat /var/log/syslog" } }]);
	assert.deepStrictEqual(out, [{ tool: "bash", target: "/var/log/syslog", category: "other" }]);
});

test("an allowlisted path is extracted but not flagged", () => {
	// /etc stays in the `ignored` allowlist by decision: the sandbox mounts it read-only, so
	// naming it proves nothing. The extractor keeps the token; the tripwire does not flag it.
	const out = workspaceEscapes(ws, [{ tool: "bash", args: { command: "cat /etc/passwd" } }]);
	assert.deepStrictEqual(out, []);
});
