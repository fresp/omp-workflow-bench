#!/usr/bin/env node
// Stage 3b — aggregate compiled runs + judgments into results/<label>/report.md and summary.json.
// Usage: node harness/report.mjs [--label L]
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { listTasks } from "./lib/config.mjs";
import { listRunDirs, readJson, resolveLabel, RESULTS } from "./lib/results.mjs";
import { bootstrapCI, mean, median, signTest } from "./lib/stats.mjs";

const { values: argv } = parseArgs({ strict: false, options: { label: { type: "string" } } });
const label = resolveLabel(argv.label);
const base = join(RESULTS, label);
const taskMeta = Object.fromEntries(listTasks().map((t) => [t.id, t]));
const manifest = readJson(join(base, "run-manifest.json"), {});

const runs = listRunDirs(label)
	.map((r) => readJson(join(r.dir, "compiled.json")))
	.filter(Boolean);
if (runs.length === 0) {
	console.error(`no compiled runs under results/${label} — run ./compile.sh first`);
	process.exit(1);
}
const ARMS = ["plan", "readyset"];
const byArm = (arm) => runs.filter((r) => r.arm === arm);
const taskIds = [...new Set(runs.map((r) => r.task))].sort();

// ---------------------------------------------------------------- objective metrics ----------
const METRICS = [
	["hiddenPassRate", "Hidden tests passed", pct],
	["solved", "Tasks fully solved (all hidden tests)", pct],
	["ownSuiteGreen", "Repo's own test suite green", pct],
	["filesChanged", "Code files changed", num1],
	["churn", "Lines changed (+/−)", num0],
	["unexpected", "Files touched outside expected scope", num2],
	["dangling", "Dangling file refs in plan", num2],
	["planChars", "Planning output size (chars)", num0],
	["simUserAnswers", "Questions answered by the user", num1],
	["nudges", "Nudges / resumes needed", num2],
	["prepMin", "Prep wall time (min)", num1],
	["execMin", "Exec wall time (min)", num1],
	["wallMin", "Total wall time (min)", num1],
	["tokensPrep", "Tokens — prep", kfmt],
	["tokensExec", "Tokens — exec", kfmt],
	["tokensTotal", "Tokens — total", kfmt],
	["cost", "Cost (as reported by omp)", money],
];
const value = (r, key) => {
	switch (key) {
		case "solved":
		case "ownSuiteGreen":
			return r[key] ? 1 : 0;
		case "churn":
			return r.linesAdded + r.linesDeleted;
		case "unexpected":
			return r.unexpectedFiles.length;
		case "dangling":
			return r.grounding?.dangling?.length ?? 0;
		case "prepMin":
			return r.prepMs == null ? null : r.prepMs / 60000;
		case "execMin":
			return r.execMs == null ? null : r.execMs / 60000;
		case "wallMin":
			return r.wallMs == null ? null : r.wallMs / 60000;
		default:
			return r[key];
	}
};

/** Per task: mean(readyset) − mean(plan) over all models × reps. */
function pairedByTask(key, rows = runs) {
	return taskIds
		.map((t) => {
			const p = mean(rows.filter((r) => r.task === t && r.arm === "plan").map((r) => value(r, key)));
			const s = mean(rows.filter((r) => r.task === t && r.arm === "readyset").map((r) => value(r, key)));
			return p == null || s == null ? null : { task: t, plan: p, readyset: s, delta: s - p };
		})
		.filter(Boolean);
}

const objective = METRICS.map(([key, name, fmt]) => {
	const planV = mean(byArm("plan").map((r) => value(r, key)));
	const rsV = mean(byArm("readyset").map((r) => value(r, key)));
	const paired = pairedByTask(key);
	const ci = bootstrapCI(paired.map((p) => [p.delta]), (xs) => mean(xs));
	return { key, name, fmt, plan: planV, readyset: rsV, delta: mean(paired.map((p) => p.delta)), ci, sign: signTest(paired.map((p) => p.delta)) };
});

// ---------------------------------------------------------------- judgments ------------------
const judgments = [];
const jdir = join(base, "judgments");
if (existsSync(jdir)) {
	for (const t of readdirSync(jdir).filter((d) => statSync(join(jdir, d)).isDirectory())) for (const f of readdirSync(join(jdir, t)).filter((f) => f.endsWith(".json"))) judgments.push(readJson(join(jdir, t, f)));
}
const judgeErrors = judgments.filter((j) => j.error).length;

/** Combine the AB and BA orders of one (pair, kind, judge): agreeing wins count, otherwise tie. */
function combined(kind) {
	const groups = new Map();
	for (const j of judgments.filter((j) => j.kind === kind && !j.error && j.byArm)) {
		const k = `${j.taskDir}|${j.modelSlug}|${j.rep}|${j.judge}`;
		if (!groups.has(k)) groups.set(k, []);
		groups.get(k).push(j);
	}
	const out = [];
	for (const [k, js] of groups) {
		const [taskDir, modelSlug, rep, judge] = k.split("|");
		const dims = {};
		let consistent = 0;
		let comparable = 0;
		for (const dim of Object.keys(js[0].byArm)) {
			const votes = js.map((j) => j.byArm[dim]);
			const agree = votes.every((v) => v === votes[0]);
			dims[dim] = agree ? votes[0] : "tie";
			if (js.length > 1) {
				comparable++;
				if (agree) consistent++;
			}
		}
		out.push({ task: js[0].task, taskDir, modelSlug, rep: Number(rep), judge, dims, orders: js.length, consistency: comparable ? consistent / comparable : null });
	}
	return out;
}

function winRate(items, dim) {
	const w = items.filter((i) => i.dims[dim] === "readyset").length;
	const l = items.filter((i) => i.dims[dim] === "plan").length;
	const t = items.filter((i) => i.dims[dim] === "tie").length;
	const n = w + l + t;
	const rate = n ? (w + 0.5 * t) / n : null;
	const clusters = taskIds.map((task) => items.filter((i) => i.task === task).map((i) => (i.dims[dim] === "readyset" ? 1 : i.dims[dim] === "tie" ? 0.5 : 0)));
	return { w, t, l, n, rate, ci: bootstrapCI(clusters, (xs) => mean(xs)) };
}

const judged = {};
for (const kind of ["plan", "code"]) {
	const items = combined(kind);
	if (!items.length) continue;
	const dims = Object.keys(items[0].dims);
	const perJudge = {};
	for (const judge of [...new Set(items.map((i) => i.judge))]) {
		const mine = items.filter((i) => i.judge === judge);
		perJudge[judge] = { overall: winRate(mine, "overall"), positionConsistency: mean(mine.map((i) => i.consistency)) };
	}
	// Inter-judge agreement on the combined overall verdict, over pairs seen by ≥ 2 judges.
	const byPair = new Map();
	for (const i of items) {
		const k = `${i.taskDir}|${i.modelSlug}|${i.rep}`;
		if (!byPair.has(k)) byPair.set(k, []);
		byPair.get(k).push(i.dims.overall);
	}
	const multi = [...byPair.values()].filter((v) => v.length > 1);
	judged[kind] = {
		dims: Object.fromEntries(dims.map((d) => [d, winRate(items, d)])),
		perJudge,
		interJudgeAgreement: multi.length ? multi.filter((v) => v.every((x) => x === v[0])).length / multi.length : null,
		items,
	};
}

// ---------------------------------------------------------------- breakdowns -----------------
function breakdown(field) {
	const groups = [...new Set(runs.map((r) => r[field]))].sort();
	return groups.map((g) => {
		const rows = runs.filter((r) => r[field] === g);
		const hidden = pairedByTask("hiddenPassRate", rows);
		const planOverall = judged.plan ? winRate(judged.plan.items.filter((i) => taskMeta[i.task]?.[field] === g), "overall") : null;
		const codeOverall = judged.code ? winRate(judged.code.items.filter((i) => taskMeta[i.task]?.[field] === g), "overall") : null;
		return {
			group: g,
			tasks: hidden.length,
			planHidden: mean(hidden.map((h) => h.plan)),
			readysetHidden: mean(hidden.map((h) => h.readyset)),
			delta: mean(hidden.map((h) => h.delta)),
			questionsPlan: mean(rows.filter((r) => r.arm === "plan").map((r) => r.simUserAnswers)),
			questionsReadyset: mean(rows.filter((r) => r.arm === "readyset").map((r) => r.simUserAnswers)),
			planJudge: planOverall?.rate ?? null,
			codeJudge: codeOverall?.rate ?? null,
		};
	});
}

const perTask = taskIds.map((t) => {
	const h = pairedByTask("hiddenPassRate").find((p) => p.task === t);
	const pj = judged.plan ? winRate(judged.plan.items.filter((i) => i.task === t), "overall") : null;
	const cj = judged.code ? winRate(judged.code.items.filter((i) => i.task === t), "overall") : null;
	return { task: t, title: taskMeta[t]?.title, clarity: taskMeta[t]?.clarity, ...h, planJudge: pj, codeJudge: cj };
});

const statusCounts = Object.fromEntries(ARMS.map((a) => [a, countBy(byArm(a).map((r) => r.status))]));
const drift = runs.filter((r) => r.modelDrift);
const models = [...new Set(runs.map((r) => r.model))];
const reps = Math.max(...runs.map((r) => r.rep));

// ---------------------------------------------------------------- write ----------------------
const hiddenRow = objective.find((o) => o.key === "hiddenPassRate");
const md = [];
md.push(`# /plan vs /readyset — benchmark report (${label})`);
md.push("");
md.push(`Tasks: **${taskIds.length}** · models: **${models.join(", ")}** · reps per cell: **${reps}** · runs compiled: **${runs.length}**`);
if (manifest.omp) md.push(`omp ${manifest.omp.version ?? "?"} · readyset-flow ${manifest.readyset?.version ?? "?"} @ ${manifest.readyset?.gitSha ?? "?"} · run started ${manifest.startedAt ?? "?"}`);
md.push("");
md.push("## Headline");
md.push("");
md.push(
	`- **Hidden tests passed:** /plan ${pct(hiddenRow.plan)} vs /readyset ${pct(hiddenRow.readyset)} — paired Δ ${signed(hiddenRow.delta, pct)} (95% CI ${ci(hiddenRow.ci, pct)}; sign test over tasks ${hiddenRow.sign.pos}↑ ${hiddenRow.sign.neg}↓, p=${hiddenRow.sign.p.toFixed(3)})`,
);
for (const kind of ["plan", "code"]) {
	if (!judged[kind]) continue;
	const o = judged[kind].dims.overall;
	md.push(
		`- **Judges — ${kind === "plan" ? "planning output" : "implemented code"} (overall):** /readyset win rate ${pct(o.rate)} (95% CI ${ci(o.ci, pct)}) — ${o.w} wins, ${o.t} ties, ${o.l} losses`,
	);
}
const tokens = objective.find((o) => o.key === "tokensTotal");
const wall = objective.find((o) => o.key === "wallMin");
md.push(`- **Cost:** tokens ${kfmt(tokens.plan)} vs ${kfmt(tokens.readyset)} per run; wall time ${num1(wall.plan)} vs ${num1(wall.readyset)} min per run`);
md.push("");
md.push("Win rate = (wins + ½ ties) / comparisons, from /readyset's side; 50% = no difference. A judge verdict only counts as a win when it holds with A/B positions swapped.");
md.push("");
md.push("## Objective metrics (mean per run; Δ = /readyset − /plan, paired by task)");
md.push("");
md.push("| Metric | /plan | /readyset | Δ | 95% CI (task bootstrap) |");
md.push("| --- | ---: | ---: | ---: | --- |");
for (const o of objective) md.push(`| ${o.name} | ${o.fmt(o.plan)} | ${o.fmt(o.readyset)} | ${signed(o.delta, o.fmt)} | ${ci(o.ci, o.fmt)} |`);
md.push("");
for (const kind of ["plan", "code"]) {
	if (!judged[kind]) continue;
	md.push(`## Judges — ${kind === "plan" ? "planning output (blind, normalized)" : "implemented code (diffs only)"}`);
	md.push("");
	md.push("| Dimension | /readyset win rate | 95% CI | W / T / L |");
	md.push("| --- | ---: | --- | --- |");
	for (const [dim, w] of Object.entries(judged[kind].dims)) md.push(`| ${dim} | ${pct(w.rate)} | ${ci(w.ci, pct)} | ${w.w} / ${w.t} / ${w.l} |`);
	md.push("");
	md.push("| Judge | overall win rate | position consistency |");
	md.push("| --- | ---: | ---: |");
	for (const [j, v] of Object.entries(judged[kind].perJudge)) md.push(`| ${j} | ${pct(v.overall.rate)} (${v.overall.w}/${v.overall.t}/${v.overall.l}) | ${pct(v.positionConsistency)} |`);
	md.push("");
	md.push(`Inter-judge agreement on overall verdict: ${pct(judged[kind].interJudgeAgreement)}`);
	md.push("");
}
for (const [field, title] of [["clarity", "By request clarity"], ["category", "By task category"]]) {
	md.push(`## ${title}`);
	md.push("");
	md.push("| Group | tasks | hidden /plan | hidden /readyset | Δ | questions /plan | questions /readyset | plan judge | code judge |");
	md.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
	for (const b of breakdown(field)) {
		md.push(`| ${b.group} | ${b.tasks} | ${pct(b.planHidden)} | ${pct(b.readysetHidden)} | ${signed(b.delta, pct)} | ${num1(b.questionsPlan)} | ${num1(b.questionsReadyset)} | ${pct(b.planJudge)} | ${pct(b.codeJudge)} |`);
	}
	md.push("");
}
md.push("## Per task");
md.push("");
md.push("| Task | clarity | hidden /plan | hidden /readyset | Δ | plan judge (W/T/L) | code judge (W/T/L) |");
md.push("| --- | --- | ---: | ---: | ---: | --- | --- |");
for (const t of perTask) {
	md.push(
		`| ${t.task} ${t.title ?? ""} | ${t.clarity ?? ""} | ${pct(t.plan)} | ${pct(t.readyset)} | ${signed(t.delta, pct)} | ${t.planJudge ? `${t.planJudge.w}/${t.planJudge.t}/${t.planJudge.l}` : "—"} | ${t.codeJudge ? `${t.codeJudge.w}/${t.codeJudge.t}/${t.codeJudge.l}` : "—"} |`,
	);
}
md.push("");
md.push("## Run health");
md.push("");
for (const a of ARMS) md.push(`- ${a}: ${Object.entries(statusCounts[a]).map(([k, v]) => `${k} ${v}`).join(", ") || "—"}`);
md.push(`- runs where omp routed to a model other than the intended one (fallback): ${drift.length}${drift.length ? ` — ${drift.map((r) => `${r.task}/${r.arm}/r${r.rep}: ${r.modelDrift.join(",")}`).join("; ")}` : ""}`);
md.push(`- judge calls that failed: ${judgeErrors}`);
md.push(`- runs with code changed before approval: ${runs.filter((r) => r.codeChangedBeforeApproval?.length).map((r) => `${r.task}/${r.arm}/r${r.rep}`).join(", ") || "none"}`);
md.push("");
md.push("See README.md → Methodology for what each number means and its known limitations.");

writeFileSync(join(base, "report.md"), `${md.join("\n")}\n`);
writeFileSync(
	join(base, "summary.json"),
	`${JSON.stringify({ label, taskCount: taskIds.length, models, reps, objective: objective.map(({ fmt, ...o }) => o), judged: Object.fromEntries(Object.entries(judged).map(([k, v]) => [k, { dims: v.dims, perJudge: v.perJudge, interJudgeAgreement: v.interJudgeAgreement }])), perTask, statusCounts }, null, 2)}\n`,
);
console.log(`report → results/${label}/report.md`);

// ---------------------------------------------------------------- formatting -----------------
function countBy(xs) {
	return xs.reduce((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
}
function pct(x) {
	return x == null ? "—" : `${(x * 100).toFixed(0)}%`;
}
function num0(x) {
	return x == null ? "—" : Math.round(x).toLocaleString("en-US");
}
function num1(x) {
	return x == null ? "—" : x.toFixed(1);
}
function num2(x) {
	return x == null ? "—" : x.toFixed(2);
}
function kfmt(x) {
	return x == null ? "—" : x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}k` : String(Math.round(x));
}
function money(x) {
	return x == null ? "—" : `$${x.toFixed(3)}`;
}
function signed(x, fmt) {
	if (x == null) return "—";
	if (fmt === pct) return `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(0)} pt`;
	const s = fmt(Math.abs(x));
	return `${x >= 0 ? "+" : "−"}${s}`;
}
function ci(interval, fmt) {
	if (!interval) return "—";
	if (fmt === pct && interval[0] < 0) return `[${signed(interval[0], pct)}, ${signed(interval[1], pct)}]`;
	return `[${fmt === pct ? pct(interval[0]) : signedOrPlain(interval[0], fmt)}, ${fmt === pct ? pct(interval[1]) : signedOrPlain(interval[1], fmt)}]`;
}
function signedOrPlain(x, fmt) {
	return x < 0 ? `−${fmt(Math.abs(x))}` : fmt(x);
}
void median;
