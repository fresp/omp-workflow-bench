#!/usr/bin/env node
// Quick-check: a small, opinionated pass/fail gate for a wave of readyset changes, comparing a label
// against a baseline label's /plan and readyset arms. Reads only; writes results/<label>/quick-check.md.
//
//   node harness/quick-check.mjs --label <new> [--baseline v0.12]
//
// Criteria live in bench.config.json → quickCheck (see bench.config.json.example). Each is a
// boolean/rate check; the output is one pass/fail per criterion plus the numbers behind it.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./lib/config.mjs";
import { listRunDirs, readJson, resolveLabel, RESULTS } from "./lib/results.mjs";

const { values: argv } = parseArgs({ strict: false, options: { label: { type: "string" }, baseline: { type: "string", default: "v0.12" } } });
const cfg = loadConfig();
const label = resolveLabel(argv.label);
const baseline = argv.baseline;
const qc = cfg.quickCheck ?? {};

const load = (l) =>
	listRunDirs(l)
		.map((r) => ({ ...r, c: readJson(join(r.dir, "compiled.json")) }))
		.filter((r) => r.c);
const cur = load(label);
const base = load(baseline);
const byTask = (rows) => {
	const m = new Map();
	for (const r of rows) {
		if (!m.has(r.taskDir)) m.set(r.taskDir, { plan: [], readyset: [] });
		m.get(r.taskDir)[r.arm]?.push(r);
	}
	return m;
};
const curT = byTask(cur);
const baseT = byTask(base);
const taskIds = [...curT.keys()].sort();

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

// 1. No per-task hidden regression > 1 test vs baseline readyset, and any task listed in
//    quickCheck.mustImprove improves.
const rsHidden = (map, t) => {
	const rs = map.get(t)?.readyset ?? [];
	const vals = rs.map((r) => r.c.hiddenPass).filter((v) => typeof v === "number");
	return vals.length ? mean(vals) : null;
};
let worstDrop = 0;
let worstTask = null;
for (const t of taskIds) {
	const now = rsHidden(curT, t);
	const was = rsHidden(baseT, t);
	if (now == null || was == null) continue;
	const drop = was - now;
	if (drop > worstDrop) {
		worstDrop = drop;
		worstTask = t;
	}
}
const maxDrop = qc.maxHiddenDrop ?? 1;
check(`no per-task hidden drop > ${maxDrop} test`, worstDrop <= maxDrop, worstTask ? `worst: ${worstTask} −${worstDrop.toFixed(1)}` : "no regressions");
for (const t of qc.mustImprove ?? []) {
	const now = rsHidden(curT, t);
	const was = rsHidden(baseT, t);
	check(`${t} improves vs ${baseline}`, now != null && was != null && now > was, `${fmt(was)} → ${fmt(now)}`);
}

// 2. Lanes: listed tasks must run on the expected lane.
for (const [t, lane] of Object.entries(qc.lanes ?? {})) {
	const lanes = (curT.get(t)?.readyset ?? []).map((r) => r.c.lane);
	check(`${t} lane = ${lane}`, lanes.length > 0 && lanes.every((l) => l === lane), `lanes: ${lanes.join(", ") || "none"}`);
}

// 3. Clear-task wall time −X% vs baseline readyset.
const clearDrop = qc.clearWallDropPct ?? 40;
for (const t of qc.clearTasks ?? []) {
	const now = mean((curT.get(t)?.readyset ?? []).map((r) => r.c.wallMs));
	const was = mean((baseT.get(t)?.readyset ?? []).map((r) => r.c.wallMs));
	if (now == null || was == null) continue;
	const drop = (was - now) / was;
	check(`${t} wall time −${clearDrop}%`, drop >= clearDrop / 100, `${fmtMin(was)} → ${fmtMin(now)} (${(drop * 100).toFixed(0)}%)`);
}

// 4. No dangling refs, no protected-path changes, user edits preserved.
const dangling = cur.reduce((n, r) => n + (r.c.grounding?.dangling?.length ?? 0), 0);
check("0 dangling plan refs", dangling <= (qc.maxDangling ?? 0), `${dangling} dangling`);
const protectedChanges = cur.filter((r) => (r.c.unexpectedFiles ?? []).some((f) => /(^|\/)(fixtures|hidden-tests|reference)\//.test(f)));
check("0 protected-path changes", protectedChanges.length === 0, protectedChanges.map((r) => `${r.taskDir}/${r.arm}`).join(", ") || "none");
if (qc.userEditsPreserved) {
	const withCheck = cur.filter((r) => r.c.userEditsPreserved != null);
	const ok = withCheck.filter((r) => r.c.userEditsPreserved === true).length;
	check("user edits preserved (100%)", withCheck.length > 0 && ok === withCheck.length, `${ok}/${withCheck.length} runs`);
}

// 5. T03 code judge not a majority loss.
const t03Code = cur.filter((r) => r.taskDir.startsWith("T03") && r.c.arm === "readyset");
if (t03Code.length) {
	const verdicts = loadJudgments(label, "T03", "code");
	const losses = verdicts.filter((v) => v.byArm?.overall === "plan").length;
	const wins = verdicts.filter((v) => v.byArm?.overall === "readyset").length;
	check("T03 code judge not majority-loss", wins >= losses, `${wins} wins / ${losses} losses`);
}

// 6. Review skip rate reported (informational, never fails).
const reviewRuns = cur.filter((r) => r.c.review);
if (reviewRuns.length) {
	const skipped = reviewRuns.filter((r) => r.c.review.skipped).length;
	check("review skip rate (informational)", true, `${skipped}/${reviewRuns.length} skipped`);
}

const md = [`# Quick check — ${label} vs ${baseline}`, "", `Runner: \`node harness/quick-check.mjs --label ${label} --baseline ${baseline}\``, ""];
const hardFail = results.filter((r) => !r.pass && !r.name.includes("informational"));
md.push(hardFail.length ? `**FAIL** — ${hardFail.length} criterion(s) failed.` : "**PASS** — all criteria met.", "");
md.push("| criterion | result | detail |", "| --- | --- | --- |");
for (const r of results) md.push(`| ${r.name} | ${r.pass ? "pass" : "**FAIL**"} | ${r.detail} |`);
writeFileSync(join(RESULTS, label, "quick-check.md"), `${md.join("\n")}\n`);
console.log(`quick-check → results/${label}/quick-check.md (${hardFail.length ? "FAIL" : "PASS"})`);

function loadJudgments(l, task, kind) {
	const dir = join(RESULTS, l, "judgments");
	const out = [];
	try {
		for (const t of readdirSync(dir)) {
			if (!t.startsWith(task)) continue;
			for (const f of readdirSync(join(dir, t))) {
				if (!f.includes(`__${kind}__`) || !f.endsWith(".json")) continue;
				const j = JSON.parse(readFileSync(join(dir, t, f), "utf8"));
				if (!j.error && j.status !== "invalid") out.push(j);
			}
		}
	} catch {}
	return out;
}
function mean(xs) {
	const v = xs.filter((x) => typeof x === "number" && Number.isFinite(x));
	return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function fmt(x) {
	return x == null ? "—" : x.toFixed(2);
}
function fmtMin(ms) {
	return ms == null ? "—" : `${(ms / 60000).toFixed(1)}m`;
}
