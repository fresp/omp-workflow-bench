#!/usr/bin/env node
// Improvement digest: turn a finished label into a list of concrete things to fix in readyset.
// It only reads what compile/judge already wrote and parses the raw RPC logs; no LLM calls, no
// writes except results/<label>/improve.md.
//
// Sections:
//   1. scoreboard per task (hidden tests, status, cost)
//   2. readyset runs that did not finish, where they stopped and the warnings they raised
//   3. hidden tests one arm passed and the other failed
//   4. judge rationales where readyset lost or tied (what to fix) and where it won (what to keep)
//   5. token spend per readyset phase (where the cost goes)
//   6. questions asked of the user per arm
//
// Usage: node harness/insights.mjs [--label L]
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { listTasks } from "./lib/config.mjs";
import { listRunDirs, readJson, resolveLabel, RESULTS } from "./lib/results.mjs";

const { values: argv } = parseArgs({ options: { label: { type: "string" } } });
const label = resolveLabel(argv.label);
const base = join(RESULTS, label);
const tasks = Object.fromEntries(listTasks().map((t) => [t.id, t]));

// ---------------------------------------------------------------- load --------------------------
const runs = listRunDirs(label).map((r) => ({
	...r,
	metrics: readJson(join(r.dir, "metrics.json")),
	compiled: readJson(join(r.dir, "compiled.json")),
}));
const taskIds = [...new Set(runs.map((r) => r.taskDir.slice(0, 3)))].sort();
const pick = (task, arm) => runs.filter((r) => r.taskDir.startsWith(task) && r.arm === arm);

const judgments = [];
const jdir = join(base, "judgments");
if (existsSync(jdir)) {
	for (const t of readdirSync(jdir).filter((d) => statSync(join(jdir, d)).isDirectory())) {
		for (const f of readdirSync(join(jdir, t)).filter((f) => f.endsWith(".json"))) {
			const j = readJson(join(jdir, t, f));
			if (j && !j.error && j.byArm) judgments.push(j);
		}
	}
}

const md = [];
const h = (s) => md.push("", s, "");
md.push(`# Improvement digest — ${label}`);
md.push("");
md.push(
	"Generated from compiled runs, judge verdicts and raw RPC logs. Each section is a source of concrete fixes, " +
		"not a score. n is small: treat single-task observations as leads to investigate, patterns across tasks as findings.",
);

// ---------------------------------------------------------------- 1. scoreboard -----------------
h("## 1. Scoreboard");
md.push("| Task | clarity | /plan hidden | /readyset hidden | /readyset status | tokens plan → readyset | wall plan → readyset |");
md.push("| --- | --- | ---: | ---: | --- | ---: | ---: |");
for (const t of taskIds) {
	const p = pick(t, "plan")[0];
	const s = pick(t, "readyset")[0];
	const hid = (r) => (r?.compiled ? `${r.compiled.hiddenPass}/${r.compiled.hiddenTotal}` : "—");
	const tok = (r) => (r?.metrics?.tokens?.total?.total != null ? kfmt(r.metrics.tokens.total.total) : "—");
	const wall = (r) => (r?.metrics?.wallMs != null ? `${(r.metrics.wallMs / 60000).toFixed(1)}m` : "—");
	const status = s?.metrics?.status ?? (s ? "crashed (no metrics)" : "not run");
	md.push(`| ${t} ${tasks[t]?.title ?? ""} | ${tasks[t]?.clarity ?? ""} | ${hid(p)} | ${hid(s)} | ${status} | ${tok(p)} → ${tok(s)} | ${wall(p)} → ${wall(s)} |`);
}

// ---------------------------------------------------------------- 2. readyset failures ----------
h("## 2. Readyset runs that did not finish");
const failed = runs.filter((r) => r.arm === "readyset" && r.metrics?.status !== "done");
if (!failed.length) md.push("_None — every readyset run reached the archive prompt._");
for (const r of failed) {
	const m = r.metrics;
	md.push(`### ${r.taskDir} (rep ${r.rep}) — ${m?.status ?? "crashed, no metrics.json"}`);
	if (!m) {
		md.push("", "The driver died before writing metrics (see `logs/`). No phase data.", "");
		continue;
	}
	const stoppedIn = m.prepAt ? "after approval (Apply / verification / Code review)" : m.brainstormAt ? "Explore / Propose (before the review gate)" : "Grilling";
	md.push("", `- stopped in: **${stoppedIn}**; nudges ${m.nudges}, resumes ${m.resumes ?? 0}, user answers ${m.simUserAnswers}`);
	const warnings = (m.events ?? []).filter((e) => e.what === "notify" && (e.level === "warning" || /doesn't look finished|Paused at|budget|failed/i.test(e.message ?? "")));
	const counts = new Map();
	for (const w of warnings) {
		const key = w.message.replace(/"[^"]*"/g, '"…"').slice(0, 200);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	for (const [msg, n] of counts) md.push(`- ${n}× \`${msg}\``);
	if (m.gateWarnings?.length) for (const g of m.gateWarnings) md.push(`- brainstorm gate: ${g.slice(0, 200)}`);
	if (m.errors?.length) for (const e of m.errors.filter((e) => !/get_messages/.test(e))) md.push(`- harness error: ${e.slice(0, 200)}`);
	md.push("");
}

// ---------------------------------------------------------------- 3. hidden test deltas ---------
h("## 3. Hidden tests one arm passed and the other failed");
let anyDelta = false;
for (const t of taskIds) {
	const p = pick(t, "plan")[0]?.compiled;
	const s = pick(t, "readyset")[0]?.compiled;
	if (!p || !s) continue;
	const pf = new Set(p.hiddenFailures ?? []);
	const sf = new Set(s.hiddenFailures ?? []);
	const onlyRs = [...sf].filter((f) => !pf.has(f));
	const onlyPlan = [...pf].filter((f) => !sf.has(f));
	if (!onlyRs.length && !onlyPlan.length) continue;
	anyDelta = true;
	md.push(`### ${t} ${tasks[t]?.title ?? ""}`);
	for (const f of onlyRs) md.push(`- ❌ readyset failed, /plan passed: ${f}`);
	for (const f of onlyPlan) md.push(`- ✅ readyset passed, /plan failed: ${f}`);
	md.push("");
}
if (!anyDelta) md.push("_No per-test differences between arms (or not enough compiled pairs)._");
md.push("");
md.push("For each ❌: check `sim-user.ndjson` (was the deciding fact ever asked?), the brainstorm, and the spec. A missed question is a grilling fix; a decided-but-not-built requirement is an Apply fix.");

// ---------------------------------------------------------------- 4. judge rationales -----------
h("## 4. What the judges said");
if (!judgments.length) {
	md.push("_No judgments yet — run `./bench.sh` first._");
} else {
	for (const kind of ["plan", "code"]) {
		const mine = judgments.filter((j) => j.kind === kind);
		if (!mine.length) continue;
		md.push(`### ${kind === "plan" ? "Planning output" : "Implemented code"}`);
		// Dimensions readyset loses, counted over every verdict (both orders, all judges).
		const dims = Object.keys(mine[0].byArm);
		md.push("", "| dimension | readyset wins | ties | readyset losses |", "| --- | ---: | ---: | ---: |");
		for (const d of dims) {
			const w = mine.filter((j) => j.byArm[d] === "readyset").length;
			const l = mine.filter((j) => j.byArm[d] === "plan").length;
			md.push(`| ${d} | ${w} | ${mine.length - w - l} | ${l} |`);
		}
		const lost = mine.filter((j) => j.byArm.overall !== "readyset");
		const won = mine.filter((j) => j.byArm.overall === "readyset");
		md.push("", `**Readyset lost or tied overall (${lost.length}) — fix these:**`, "");
		if (!lost.length) md.push("_none_");
		for (const j of lost) md.push(`- **${j.task}** · ${short(j.judge)} ${j.order} · ${j.byArm.overall}: ${oneLine(j.verdict?.rationale)}`);
		md.push("", `**Readyset won overall (${won.length}) — keep these:**`, "");
		for (const j of won.slice(0, 12)) md.push(`- **${j.task}** · ${short(j.judge)} ${j.order}: ${oneLine(j.verdict?.rationale)}`);
		if (won.length > 12) md.push(`- … ${won.length - 12} more in \`judgments/\``);
		md.push("");
	}
}

// ---------------------------------------------------------------- 5. token spend per phase ------
h("## 5. Where readyset's tokens go (per phase)");
md.push("Parsed from each run's `rpc.ndjson` (usage per assistant message). `ctx` = fresh input + cache read, i.e. what was re-sent.");
md.push("");
md.push("| Task | grill | explore | propose | apply | review | calls | max ctx | cache share |");
md.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
const phaseTotals = {};
for (const r of runs.filter((r) => r.arm === "readyset")) {
	const ph = phaseUsage(join(r.dir, "rpc.ndjson"));
	if (!ph) continue;
	const cell = (p) => (ph.phases[p] ? kfmt(ph.phases[p].total) : "—");
	for (const [p, v] of Object.entries(ph.phases)) phaseTotals[p] = (phaseTotals[p] ?? 0) + v.total;
	md.push(`| ${r.taskDir.slice(0, 3)} | ${cell("grill")} | ${cell("explore")} | ${cell("propose")} | ${cell("apply")} | ${cell("review")} | ${ph.calls} | ${kfmt(ph.maxCtx)} | ${pct(ph.cacheShare)} |`);
}
const grand = Object.values(phaseTotals).reduce((a, b) => a + b, 0);
if (grand) {
	md.push("", "Share of all readyset tokens by phase: " + Object.entries(phaseTotals).sort((a, b) => b[1] - a[1]).map(([p, v]) => `${p} ${pct(v / grand)}`).join(" · "));
}

// ---------------------------------------------------------------- 6. questions asked ------------
h("## 6. Questions asked of the user");
md.push("| Task | clarity | /plan answers | /readyset answers | readyset replies that were empty or off-script |");
md.push("| --- | --- | ---: | ---: | ---: |");
for (const t of taskIds) {
	const p = pick(t, "plan")[0];
	const s = pick(t, "readyset")[0];
	const log = s ? readLines(join(s.dir, "sim-user.ndjson")) : [];
	const odd = log.filter((e) => e.needsReply === false && /\?\s*$/.test(e.agent ?? "")).length + log.filter((e) => e.error).length;
	md.push(`| ${t} | ${tasks[t]?.clarity ?? ""} | ${p?.metrics?.simUserAnswers ?? "—"} | ${s?.metrics?.simUserAnswers ?? "—"} | ${odd} |`);
}
md.push("");
md.push("Low /plan counts on ambiguous tasks with hidden-test losses = /plan guessed. High readyset counts on clear tasks with no hidden-test gain = grilling cost that bought nothing.");

writeFileSync(join(base, "improve.md"), `${md.join("\n")}\n`);
console.log(`improvement digest → results/${label}/improve.md`);

// ---------------------------------------------------------------- helpers -----------------------
function phaseUsage(file) {
	if (!existsSync(file)) return null;
	let phase = "grill";
	const phases = {};
	let calls = 0;
	let maxCtx = 0;
	let cache = 0;
	let all = 0;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		let f;
		try {
			f = JSON.parse(line);
		} catch {
			continue;
		}
		if (f.type === "extension_ui_request" && f.method === "notify") {
			const m = f.message ?? "";
			if (/Exploring ground truth/.test(m)) phase = "explore";
			else if (/Proposing change/.test(m)) phase = "propose";
			else if (/Approved\. Implementing|Asking .* to verify/.test(m)) phase = "apply";
			else if (/Running code review/.test(m)) phase = "review";
		}
		if (f.type === "message_end" && f.message?.role === "assistant") {
			const u = f.message.usage ?? {};
			const input = u.input ?? 0;
			const read = u.cacheRead ?? 0;
			const out = u.output ?? 0;
			const p = (phases[phase] ??= { total: 0 });
			p.total += input + read + out;
			calls++;
			maxCtx = Math.max(maxCtx, input + read);
			cache += read;
			all += input + read + out;
		}
	}
	return { phases, calls, maxCtx, cacheShare: all ? cache / all : null };
}

function readLines(file) {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return {};
			}
		});
}

function oneLine(text) {
	return String(text ?? "(no rationale)").replace(/\s+/g, " ").trim().slice(0, 600);
}
function short(model) {
	return String(model).split("/").pop();
}
function kfmt(x) {
	return x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(0)}k` : String(Math.round(x));
}
function pct(x) {
	return x == null ? "—" : `${Math.round(x * 100)}%`;
}
