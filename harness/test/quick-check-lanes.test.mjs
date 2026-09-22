// Locks quick-check.mjs's lanes criterion: it must judge the arm that decides the lane
// (readyset-auto), not every readyset arm at once.
// Run: node --test harness/test/quick-check-lanes.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const QC = join(ROOT, "harness", "quick-check.mjs");

// A compiled.json only needs the fields the lanes criterion reads; every other criterion is
// neutralized by BENCH_QUICKCHECK_JSON below, so the test is independent of bench.config.json.
const writeRun = (label, task, cell, lane) => {
	const dir = join(ROOT, "results", label, task, cell);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "compiled.json"), `${JSON.stringify({ arm: "readyset", lane })}\n`);
};

const runQc = (label, lanes) => {
	const env = {
		...process.env,
		BENCH_QUICKCHECK_JSON: JSON.stringify({ maxHiddenDrop: 1, mustImprove: [], lanes, clearTasks: [], clearWallDropPct: 40, maxDangling: 0, userEditsPreserved: false }),
	};
	const r = spawnSync("node", [QC, "--label", label, "--baseline", label], { cwd: ROOT, env, encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr || r.stdout);
	return readFileSync(join(ROOT, "results", label, "quick-check.md"), "utf8");
};

test("explicit fast+full arms for one task still pass the lane check", () => {
	const label = "__qc-lanes-explicit";
	const task = "T09-csv-quoting-bug";
	try {
		writeRun(label, task, "readyset-fast__m__r1", "fast");
		writeRun(label, task, "readyset-full__m__r1", "full");
		const md = runQc(label, { [task]: "fast" });
		assert.ok(!md.includes("**FAIL**"), md);
		assert.match(md, /\*\*PASS\*\*/, md);
		assert.ok(md.includes(`| ${task} lane = fast | pass |`), md);
	} finally {
		rmSync(join(ROOT, "results", label), { recursive: true, force: true });
	}
});

test("wrong lane on the auto arm fails the lane check (negative control)", () => {
	const label = "__qc-lanes-wrong";
	const task = "T09-csv-quoting-bug";
	try {
		writeRun(label, task, "readyset-auto__m__r1", "full");
		const md = runQc(label, { [task]: "fast" });
		assert.ok(md.includes("**FAIL**"), md);
		assert.ok(md.includes(`| ${task} lane = fast | **FAIL** |`), md);
		assert.ok(md.includes("lanes: full (arms: readyset-auto)"), md);
	} finally {
		rmSync(join(ROOT, "results", label), { recursive: true, force: true });
	}
});

test("a lane-listed task with no runs is skipped, not failed", () => {
	const label = "__qc-lanes-absent";
	const other = "T03-discount-rounding-bug";
	try {
		// Only T03 ran; the T09/T04 lane criteria must not appear as FAIL rows.
		writeRun(label, other, "readyset-auto__m__r1", "fast");
		const md = runQc(label, { [other]: "fast", "T09-csv-quoting-bug": "fast", "T04-rate-limiting": "full" });
		assert.ok(md.includes(`| ${other} lane = fast | pass |`), md);
		assert.ok(!md.includes("T09-csv-quoting-bug lane"), md);
		assert.ok(!md.includes("T04-rate-limiting lane"), md);
	} finally {
		rmSync(join(ROOT, "results", label), { recursive: true, force: true });
	}
});

test("readyset-auto is authoritative when both auto and an explicit arm ran", () => {
	const label = "__qc-lanes-auto";
	const task = "T04-rate-limiting";
	try {
		writeRun(label, task, "readyset-auto__m__r1", "fast");
		writeRun(label, task, "readyset-full__m__r1", "full");
		const md = runQc(label, { [task]: "fast" });
		assert.ok(!md.includes("**FAIL**"), md);
		assert.match(md, /\*\*PASS\*\*/, md);
		assert.ok(md.includes(`| ${task} lane = fast | pass |`), md);
		assert.ok(md.includes("(arms: readyset-auto)"), md);
	} finally {
		rmSync(join(ROOT, "results", label), { recursive: true, force: true });
	}
});
