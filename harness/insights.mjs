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
//   7. what execution spends its tool calls on (both arms)
//
// Usage: node harness/insights.mjs [--label L]
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { listTasks } from "./lib/config.mjs";
import { listRunDirs, readJson, resolveLabel, RESULTS } from "./lib/results.mjs";
import { parseToolCalls } from "./lib/run-common.mjs";

const { values: argv } = parseArgs({ options: { label: { type: "string" }, baseline: { type: "string" } } });
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
/** Every run (all reps) of one task × arm. */
const picks = (task, arm) => runs.filter((r) => r.taskDir.startsWith(task) && r.arm === arm);
/** The first run — for single-value call sites only; never for aggregation. */
const pick = (task, arm) => picks(task, arm)[0];

const judgments = [];
const jdir = join(base, "judgments");
if (existsSync(jdir)) {
	for (const t of readdirSync(jdir).filter((d) => statSync(join(jdir, d)).isDirectory())) {
		for (const f of readdirSync(join(jdir, t)).filter((f) => f.endsWith(".json"))) {
			const j = readJson(join(jdir, t, f));
			// Keep every record — including errored and malformed ones — so they can be reported,
			// not silently dropped. `j && !j.error && j.byArm` used to hide both, which let 4
			// verdicts with no `overall` key disappear from both the won and lost lists.
			if (j) judgments.push({ ...j, _file: `${t}/${f}` });
		}
	}
}

const VERDICT = new Set(["readyset", "plan", "tie"]);
/** A verdict counts only if it did not error and every mapped dimension is exactly readyset/plan/tie. */
function classify(j) {
	if (j.error) return { valid: false, kind: "errored", reason: String(j.error).slice(0, 160) };
	if (!j.byArm || typeof j.byArm !== "object") return { valid: false, kind: "malformed", reason: "no byArm map" };
	if (!("overall" in j.byArm)) return { valid: false, kind: "malformed", reason: "no overall dimension" };
	const bad = Object.entries(j.byArm).filter(([, v]) => !VERDICT.has(v));
	if (bad.length) return { valid: false, kind: "malformed", reason: `bad value(s): ${bad.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")}` };
	return { valid: true, kind: "valid", reason: "" };
}
for (const j of judgments) j._check = classify(j);
const validJudgments = judgments.filter((j) => j._check.valid);
const invalidJudgments = judgments.filter((j) => !j._check.valid);
const erroredFiles = new Set(judgments.filter((j) => j.error).map((j) => `${j.taskDir}/${j._file.split("/").pop()}`));

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
md.push("Per-cell values are aggregated over **all reps** (reps contributing in the `runs` column); they used to be rep 1 only.");
md.push("");
md.push("| Task | clarity | /plan hidden | /readyset hidden | /readyset status | tokens plan → readyset | wall plan → readyset | runs |");
md.push("| --- | --- | ---: | ---: | --- | ---: | ---: | ---: |");
for (const t of taskIds) {
	const ps = picks(t, "plan");
	const ss = picks(t, "readyset");
	// Hidden pass rate: mean over reps; numerator = reps fully solved, out of reps that compiled.
	const hid = (rs) => {
		const ok = rs.filter((r) => r.compiled);
		if (!ok.length) return "—";
		const rate = ok.reduce((a, r) => a + (r.compiled.hiddenPassRate ?? 0), 0) / ok.length;
		const solved = ok.filter((r) => r.compiled.solved).length;
		return `${Math.round(rate * 100)}% (${solved}/${ok.length})`;
	};
	// A number with a min–max range over the arm's reps, for the canonical compiled field.
	const range = (rs, get, fmt = kfmt) => {
		const vs = rs.map(get).filter((v) => typeof v === "number" && Number.isFinite(v));
		if (!vs.length) return "—";
		const mean = vs.reduce((a, b) => a + b, 0) / vs.length;
		const lo = Math.min(...vs);
		const hi = Math.max(...vs);
		return vs.length === 1 || lo === hi ? fmt(mean) : `${fmt(mean)} (${fmt(lo)}–${fmt(hi)})`;
	};
	const tokOf = (r) => r.compiled?.tokensTotal ?? null;
	const wallOf = (r) => r.compiled?.wallMs ?? null;
	const status = ss[0]?.metrics?.status ?? (ss.length ? "crashed (no metrics)" : "not run");
	const nRuns = new Set([...ps.map((r) => r.rep), ...ss.map((r) => r.rep)]).size;
	md.push(`| ${t} ${tasks[t]?.title ?? ""} | ${tasks[t]?.clarity ?? ""} | ${hid(ps)} | ${hid(ss)} | ${status} | ${range(ps, tokOf, kfmt)} → ${range(ss, tokOf, kfmt)} | ${range(ps, wallOf, mfmt)} → ${range(ss, wallOf, mfmt)} | ${nRuns} |`);
}

// ---------------------------------------------------------------- 1b. baseline -------------------
if (argv.baseline) {
	h(`## 1b. Baseline comparison (${label} vs ${argv.baseline})`);
	const baseRuns = listRunDirs(argv.baseline).map((r) => ({ ...r, metrics: readJson(join(r.dir, "metrics.json")), compiled: readJson(join(r.dir, "compiled.json")) }));
	if (!baseRuns.length) {
		md.push(`_No runs under results/${argv.baseline}._`);
	} else {
		// Warn when the two labels are not comparable (different model / omp / fixture versions).
		const man = (l) => readJson(join(RESULTS, l, "run-manifest.json"), {});
		const m1 = man(label);
		const m2 = man(argv.baseline);
		const diffs = [];
		if (m1.omp?.version !== m2.omp?.version) diffs.push(`omp ${m2.omp?.version} → ${m1.omp?.version}`);
		if (m1.readyset?.version !== m2.readyset?.version) diffs.push(`readyset ${m2.readyset?.version} → ${m1.readyset?.version}`);
		if (JSON.stringify(m1.models) !== JSON.stringify(m2.models)) diffs.push(`models ${JSON.stringify(m2.models)} → ${JSON.stringify(m1.models)}`);
		if (diffs.length) md.push(`⚠ labels differ: ${diffs.join("; ")} — comparisons below are indicative only.`);
		const baseP = (t) => baseRuns.filter((r) => r.taskDir.startsWith(t) && r.arm === "plan");
		const curP = (t) => picks(t, "plan");
		md.push("", "| Task | baseline /plan hidden | this /plan hidden | baseline /plan tokens | this /plan tokens |", "| --- | ---: | ---: | ---: | ---: |");
		for (const t of taskIds) {
			const bp = baseP(t);
			const cp = curP(t);
			const mean = (rs, get) => {
				const v = rs.map(get).filter((x) => typeof x === "number");
				return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
			};
			const rate = (rs) => mean(rs.filter((r) => r.compiled), (r) => r.compiled.hiddenPassRate);
			md.push(`| ${t} | ${pct(rate(bp))} | ${pct(rate(cp))} | ${kfmt(mean(bp, (r) => r.compiled?.tokensTotal))} | ${kfmt(mean(cp, (r) => r.compiled?.tokensTotal))} |`);
		}
	}
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
md.push("Counted across **all reps**: a test row appears only when the two arms' failure counts differ.");
let anyDelta = false;
for (const t of taskIds) {
	const ps = picks(t, "plan").filter((r) => r.compiled);
	const ss = picks(t, "readyset").filter((r) => r.compiled);
	if (!ps.length || !ss.length) continue;
	// failures per test name, per arm
	const count = (rs) => {
		const m = new Map();
		for (const r of rs) for (const f of r.compiled.hiddenFailures ?? []) m.set(f, (m.get(f) ?? 0) + 1);
		return m;
	};
	const pf = count(ps);
	const sf = count(ss);
	const names = [...new Set([...pf.keys(), ...sf.keys()])].sort();
	const rows = names
		.map((name) => ({ name, plan: pf.get(name) ?? 0, readyset: sf.get(name) ?? 0 }))
		.filter((r) => r.plan !== r.readyset);
	if (!rows.length) continue;
	anyDelta = true;
	md.push(`### ${t} ${tasks[t]?.title ?? ""}`);
	md.push("", `| hidden test | /plan failures | /readyset failures |`, "| --- | ---: | ---: |");
	for (const r of rows) {
		const tag = r.readyset > r.plan ? "❌ readyset" : "✅ readyset";
		md.push(`| ${r.name} | ${r.plan}/${ps.length} | ${r.readyset}/${ss.length} | ${tag} |`);
	}
	md.push("");
}
if (!anyDelta) md.push("_No per-test differences between arms (or not enough compiled pairs)._");
md.push("");
md.push("For each ❌: check `sim-user.ndjson` (was the deciding fact ever asked?), the brainstorm, and the spec. A missed question is a grilling fix; a decided-but-not-built requirement is an Apply fix.");

// ---------------------------------------------------------------- 4. judge rationales -----------
h("## 4. What the judges said — counted per verdict, both A/B orders — not swap-consolidated like report.md");
md.push("Each verdict is one (pair, kind, judge, order) record. Invalid verdicts are listed separately and excluded from both lists below.");
if (!validJudgments.length) {
	md.push("_No valid judgments yet — run `./bench.sh` first._");
} else {
	for (const kind of ["plan", "code"]) {
		const mine = validJudgments.filter((j) => j.kind === kind);
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

// Invalid verdicts get their own subsection so they are retried, never silently counted as a loss.
h("### Invalid verdicts (retry these)");
md.push(`${invalidJudgments.length} of ${judgments.length} judgment file(s) are invalid and excluded from section 4. Judgment files with an \`error\`: ${erroredFiles.size}.`);
if (invalidJudgments.length) {
	md.push("", "| task | judge | order | kind | reason |", "| --- | --- | --- | --- | --- |");
	for (const j of invalidJudgments) md.push(`| ${j.task} | ${short(j.judge)} | ${j.order} | ${j.kind} | ${j._check.kind}: ${j._check.reason} |`);
}
md.push("");

// ---------------------------------------------------------------- 5. token spend per phase ------
h("## 5. Where readyset's tokens go (per phase)");
md.push("Parsed from each run's `rpc.ndjson`: deduplicated assistant `message_end` usage (`turn_end` and `message_start` repeat the same object). `ctx` = fresh input + cache read, i.e. what was re-sent. Phase boundaries come from readyset's `<!-- readyset-phase -->` markers in `CONTEXT.md` when present (readyset ≥ 0.13), otherwise from the legacy notify regex.");
md.push("");
md.push("| Task | phase source | grill | explore | propose | apply | review | calls | max ctx | cache share |");
md.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
const phaseTotals = {};
for (const r of runs.filter((r) => r.arm === "readyset")) {
	const ph = phaseUsage(join(r.dir, "rpc.ndjson"), contextFile(r.dir));
	if (!ph) continue;
	const cell = (p) => (ph.phases[p] ? kfmt(ph.phases[p].total) : "—");
	for (const [p, v] of Object.entries(ph.phases)) phaseTotals[p] = (phaseTotals[p] ?? 0) + v.total;
	md.push(`| ${r.taskDir.slice(0, 3)} | ${ph.source} | ${cell("grill")} | ${cell("explore")} | ${cell("propose")} | ${cell("apply")} | ${cell("review")} | ${ph.calls} | ${kfmt(ph.maxCtx)} | ${pct(ph.cacheShare)} |`);
}
const grand = Object.values(phaseTotals).reduce((a, b) => a + b, 0);
if (grand) {
	md.push("", "Share of all readyset tokens by phase: " + Object.entries(phaseTotals).sort((a, b) => b[1] - a[1]).map(([p, v]) => `${p} ${pct(v / grand)}`).join(" · "));
}

// ---------------------------------------------------------------- 6. questions asked ------------
h("## 6. Questions asked of the user");
md.push("Answers are the mean over **all reps** of each arm.");
md.push("");
md.push("| Task | clarity | /plan answers | /readyset answers | readyset replies that were empty or off-script |");
md.push("| --- | --- | ---: | ---: | ---: |");
for (const t of taskIds) {
	const p = picks(t, "plan");
	const s = picks(t, "readyset");
	const meanAns = (rs) => {
		const vs = rs.map((r) => r.metrics?.simUserAnswers).filter((v) => typeof v === "number");
		return vs.length ? (vs.reduce((a, b) => a + b, 0) / vs.length).toFixed(1) : "—";
	};
	const log = s[0] ? readLines(join(s[0].dir, "sim-user.ndjson")) : [];
	const odd = log.filter((e) => e.needsReply === false && /\?\s*$/.test(e.agent ?? "")).length + log.filter((e) => e.error).length;
	md.push(`| ${t} | ${tasks[t]?.clarity ?? ""} | ${meanAns(p)} | ${meanAns(s)} | ${odd} |`);
}
md.push("");
md.push("Low /plan counts on ambiguous tasks with hidden-test losses = /plan guessed. High readyset counts on clear tasks with no hidden-test gain = grilling cost that bought nothing.");

// ---------------------------------------------------------------- 7. tool-call spend ------------
writeSection7();

writeFileSync(join(base, "improve.md"), `${md.join("\n")}\n`);
console.log(`improvement digest → results/${label}/improve.md`);

// ---------------------------------------------------------------- helpers -----------------------
/** The change dir's CONTEXT.md, from the gate snapshot or the final tree. */
function contextFile(runDir) {
	const candidates = [];
	const prep = join(runDir, "prep", "readyset-change");
	if (existsSync(prep)) for (const id of readdirSync(prep)) candidates.push(join(prep, id, "CONTEXT.md"));
	const fin = join(runDir, "final", "readyset", "changes");
	if (existsSync(fin)) for (const id of readdirSync(fin)) candidates.push(join(fin, id, "CONTEXT.md"));
	return candidates.find((f) => existsSync(f)) ?? null;
}

/**
 * Phase boundaries and per-phase token spend. Prefers readyset's own `<!-- readyset-phase -->`
 * markers in CONTEXT.md (readyset ≥ 0.13); falls back to the notify regex for older runs. Assistant
 * messages are deduplicated by `message.responseId` (else a hash of timestamp+usage) because the
 * same usage object is repeated on message_start/message_end/turn_end.
 */
function phaseUsage(file, ctxFile = null) {
	if (!existsSync(file)) return null;
	const windows = ctxFile ? phaseWindows(ctxFile) : [];
	const useMarkers = windows.length > 0;
	let phase = "grill";
	const phases = {};
	let calls = 0;
	let maxCtx = 0;
	let cache = 0;
	let all = 0;
	const seen = new Set();
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		let f;
		try {
			f = JSON.parse(line);
		} catch {
			continue;
		}
		if (!useMarkers && f.type === "extension_ui_request" && f.method === "notify") {
			const m = f.message ?? "";
			if (/Exploring ground truth/.test(m)) phase = "explore";
			else if (/Proposing change/.test(m)) phase = "propose";
			else if (/Approved\. Implementing|Asking .* to verify/.test(m)) phase = "apply";
			else if (/Running code review/.test(m)) phase = "review";
		}
		if (f.type === "message_end" && f.message?.role === "assistant") {
			const u = f.message.usage ?? {};
			const key = f.message.responseId ?? `${f.message.timestamp}|${JSON.stringify(u)}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const input = u.input ?? 0;
			const read = u.cacheRead ?? 0;
			const write = u.cacheWrite ?? 0;
			const out = u.output ?? 0;
			const ts = typeof f.message.timestamp === "number" ? f.message.timestamp : Date.parse(f.message.timestamp ?? "");
			const at = useMarkers ? phaseAt(windows, ts) : phase;
			const p = (phases[at] ??= { total: 0 });
			p.total += input + read + write + out;
			calls++;
			maxCtx = Math.max(maxCtx, input + read + write);
			cache += read;
			all += input + read + write + out;
		}
	}
	return { phases, calls, maxCtx, cacheShare: all ? cache / all : null, source: useMarkers ? "CONTEXT.md" : "regex" };
}

/** Parse `<!-- readyset-phase -->`-marked json fences into start/end windows per phase name. */
function phaseWindows(ctxFile) {
	const text = readFileSync(ctxFile, "utf8");
	const out = [];
	const re = /<!--\s*readyset-phase\s*-->\s*```json\s*([\s\S]*?)```/g;
	for (const m of text.matchAll(re)) {
		try {
			const ev = JSON.parse(m[1]);
			// A `start` opens a window; an `end` closes the matching phase. Phase names are lowercased
			// and mapped to the columns the table shows.
			const name = normPhase(ev.phase);
			if (!name) continue;
			if (ev.edge === "start" && ev.at) out.push({ name, start: Date.parse(ev.at), end: null });
			else if (ev.edge === "end") {
				const open = [...out].reverse().find((w) => w.name === name && w.end == null);
				if (open) open.end = ev.at ? Date.parse(ev.at) : Date.now();
			}
		} catch {}
	}
	for (const w of out) if (w.end == null) w.end = w.start + 1;
	return out.filter((w) => Number.isFinite(w.start));
}

function normPhase(p) {
	const s = String(p ?? "").toLowerCase();
	if (s.startsWith("grill")) return "grill";
	if (s.startsWith("explore")) return "explore";
	if (s.startsWith("propos")) return "propose";
	if (s.startsWith("apply")) return "apply";
	if (s.startsWith("review")) return "review";
	return null;
}

function phaseAt(windows, ts) {
	if (!Number.isFinite(ts)) return "other";
	const hit = windows.find((w) => ts >= w.start && ts < w.end);
	return hit?.name ?? "other";
}

/**
 * Section 7 — what execution spends its tool calls on. Uses the RPC tool_execution_start frames
 * (the verified block shape) and maps each call to the phase it happened in, so Apply's read vs
 * test mix and its re-reads can be stated directly.
 */
function writeSection7() {
	h("## 7. What execution spends its calls on (both arms)");
	md.push("Tool categories from `rpc.ndjson` (`tool_execution_start` frames). Phases as in section 5. `read` = read; `search` = glob/grep; `edit/write` = edit/write; `test` = bash matching `npm test` / `node --test` / `readyset_verify`; `other bash`; `other tools` (eval, todo, ask, hub, task, web_search…). There is no `readyset_verify` tool in v0.12 — it is a forward-compatible name.");
	md.push("");
	for (const arm of ["plan", "readyset"]) {
		const armRuns = runs.filter((r) => r.arm === arm);
		if (!armRuns.length) continue;
		const agg = { total: {}, applyReads: 0, applyTests: 0, applyEdits: 0, rereads: 0, applyReadFiles: new Set(), distinctRead: new Set(), distinctEdit: new Set(), testRuns: 0, testsWithoutEdit: 0, ctxPerCall: 0, calls: 0, otherByName: {}, taskPhases: {}, taskCalls: 0 };
		let lastEdit = -1;
		for (const r of armRuns) {
			const calls = annotateCalls(r);
			for (const c of calls) {
				agg.total[c.category] = (agg.total[c.category] ?? 0) + 1;
				if (c.category === "other tools") agg.otherByName[c.tool] = (agg.otherByName[c.tool] ?? 0) + 1;
				if (c.tool === "task") { agg.taskCalls++; (agg.taskPhases[c.phase] ??= []).push(`${r.taskDir.slice(0, 3)} r${r.rep ?? 1}`); }
				if (c.path) {
					if (c.category === "read") agg.distinctRead.add(c.path);
					if (c.category === "edit/write") agg.distinctEdit.add(c.path);
				}
				if (c.category === "test") { agg.testRuns++; if (c.idx > lastEdit) agg.testsWithoutEdit++; }
				if (c.category === "edit/write") lastEdit = c.idx;
				if (["apply", "review"].includes(c.phase) && c.category === "read" && c.path) {
					agg.applyReadFiles.add(c.path);
					if (c.seenBefore) agg.rereads++;
				}
				if (["apply", "review"].includes(c.phase) && c.category === "read") agg.applyReads++;
				if (["apply", "review"].includes(c.phase) && c.category === "test") agg.applyTests++;
				if (["apply", "review"].includes(c.phase) && c.category === "edit/write") agg.applyEdits++;
			}
			const u = perCallContext(join(r.dir, "rpc.ndjson"));
			agg.ctxPerCall += u.total; agg.calls += u.calls;
		}
		const cat = (k) => agg.total[k] ?? 0;
		md.push(`### ${arm}`);
		md.push("", "| category | calls |", "| --- | ---: |");
		for (const k of ["read", "search", "edit/write", "test", "other bash", "other tools"]) md.push(`| ${k} | ${cat(k)} |`);
		md.push(`| **total** | **${Object.values(agg.total).reduce((a, b) => a + b, 0)}** |`);
		md.push("");
		const otherNames = Object.entries(agg.otherByName).sort((a, b) => b[1] - a[1]);
		if (otherNames.length) {
			md.push("`other tools` by name:", "", "| tool | calls |", "| --- | ---: |");
			for (const [name, n] of otherNames) md.push(`| ${name} | ${n} |`);
			md.push(`| **total** | **${cat("other tools")}** |`, "");
		}
		md.push(`- distinct files read: ${agg.distinctRead.size} · distinct files edited: ${agg.distinctEdit.size}`);
		md.push(`- test runs: ${agg.testRuns} · test runs with no edit since the previous one (repeat): ${agg.testsWithoutEdit}`);
		md.push(`- re-reads in Apply/Review of a file already read earlier in the run: ${agg.rereads} (${pct(agg.applyReads ? agg.rereads / agg.applyReads : null)} of Apply/Review reads; ${agg.applyReadFiles.size} distinct files)`);
		md.push(`- avg context per call (input + cache read/write): ${agg.calls ? kfmt(agg.ctxPerCall / agg.calls) : "—"}`);
		md.push("");
		md.push(`\`task\` (subagent) calls: ${agg.taskCalls}.`, "", "| phase | calls | runs |", "| --- | ---: | --- |");
		for (const phase of ["grill", "explore", "propose", "apply", "review", "other"]) {
			const where = agg.taskPhases[phase] ?? [];
			if (!where.length) continue;
			md.push(`| ${phase} | ${where.length} | ${where.length <= 8 ? where.join(", ") : `${where.length} calls`} |`);
		}
		md.push("");
		md.push(`**(a)** Apply re-reads what Explore/Propose read: **${agg.rereads ? `yes, ${agg.rereads} time(s)` : "no"}**. **(b)** Apply/Review is ${agg.applyTests} test call(s) vs ${agg.applyReads} read call(s) — ${pct(agg.applyReads + agg.applyTests + agg.applyEdits ? agg.applyTests / (agg.applyReads + agg.applyTests + agg.applyEdits) : null)} of Apply/Review calls are testing/verification.`);
		md.push("");
	}
	md.push("**Subagent tokens.** The `task` tool's subagent output is charged to the parent session: the subagent's result is echoed inline as a tool-result message and the next assistant `message_end` carries it as **input** tokens — e.g. v0.12 T04 readyset r1 has one `task` call (1 of 5 across v0.12: T04 readyset r1, T09 readyset r2 ×2, T10 readyset r2, T11 plan r2), whose 4005-byte result is followed by a `message_end` with `input=17475 / output=77 / total=39184`. The subagent's own internal reasoning is **not** separately itemized in the parent's usage. This is a settled measurement from the traces; it is not re-derived here.");
	md.push("");
}

/** Every tool call of a run with its phase, category, normalized path and whether it was seen before. */
function annotateCalls(r) {
	const file = join(r.dir, "rpc.ndjson");
	const raw = parseToolCalls(file);
	if (!raw.length) return [];
	const ws = r.metrics?.workspace ?? null;
	// Phase per call: read the raw log in order, tracking the notify-derived phase and assigning it
	// to each tool_execution_start. CONTEXT.md markers (readyset ≥ 0.13) would give phases by
	// timestamp, but tool_execution_start carries no timestamp, so the notify stream is the only
	// per-call signal; section 5's marker-based table is the authoritative phase breakdown.
	const phaseOf = new Map();
	let phase = "grill";
	// The /plan arm emits no readyset notifies, so its calls would all sit in "grill". Bound its
	// Apply phase by the approval instant instead: everything at or after the assistant message that
	// first reports approval is execution. `prepAt` is that instant.
	const prepAt = r.metrics?.prepAt ? Date.parse(r.metrics.prepAt) : null;
	let lastMsgTs = null;
	const tsOf = (t) => (typeof t === "number" ? t : Date.parse(t ?? ""));
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
		if (f.type === "message_end" && f.message?.timestamp) lastMsgTs = tsOf(f.message.timestamp);
		if (f.type === "tool_execution_start") {
			// Plan arm: no notify markers → use approval time to split prep from apply.
			if (r.arm === "plan" && prepAt && lastMsgTs && lastMsgTs >= prepAt) phaseOf.set(f.toolCallId, "apply");
			else phaseOf.set(f.toolCallId, phase);
		}
	}
	const seenPaths = new Set();
	return raw.map((c, idx) => {
		const category = categorize(c);
		const path = c.args?.path ? normalizeWs(String(c.args.path), ws) : null;
		const seenBefore = category === "read" && path ? seenPaths.has(path) : false;
		if (category === "read" && path) seenPaths.add(path);
		return { ...c, idx, category, path, phase: phaseOf.get(c.id) ?? "grill", seenBefore };
	});
}

function categorize(c) {
	const n = c.tool;
	if (n === "read") return "read";
	if (n === "glob" || n === "grep") return "search";
	if (n === "edit" || n === "write") return "edit/write";
	if (n === "bash") {
		const cmd = String(c.args?.command ?? "");
		if (/npm\s+test\b|node\s+--test\b|readyset_verify/.test(cmd)) return "test";
		return "other bash";
	}
	return "other tools";
}

function normalizeWs(p, ws) {
	if (!ws) return p;
	if (p.startsWith(ws)) return p.slice(ws.length).replace(/^\/+/, "");
	return p;
}

function perCallContext(file) {
	if (!existsSync(file)) return { total: 0, calls: 0 };
	let total = 0;
	let calls = 0;
	const seen = new Set();
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		let f;
		try { f = JSON.parse(line); } catch { continue; }
		if (f.type !== "message_end" || f.message?.role !== "assistant") continue;
		const u = f.message.usage ?? {};
		const key = f.message.responseId ?? `${f.message.timestamp}|${JSON.stringify(u)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		total += (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
		calls++;
	}
	return { total, calls };
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
/** Milliseconds as minutes, e.g. 3.4m. */
function mfmt(ms) {
	return ms == null ? "—" : `${(ms / 60000).toFixed(1)}m`;
}
function pct(x) {
	return x == null ? "—" : `${Math.round(x * 100)}%`;
}
