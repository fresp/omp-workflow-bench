#!/usr/bin/env node
// Stage 3a — blind pairwise LLM judging of compiled bundles.
// For every (task, model, rep) where both arms ran: each judge model compares the /plan and
// /readyset outputs twice with A/B positions swapped. A dimension counts as a win only when both
// orders agree; disagreement (position bias) is recorded as a tie.
//   kind "plan": normalized planning documents      kind "code": code-only diffs
// Usage: node harness/judge.mjs [--label L] [--kinds plan,code] [--force]
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, listTasks, modelSlug, ROOT } from "./lib/config.mjs";
import { completeJson } from "./lib/llm.mjs";
import { listRunDirs, readJson, readText, resolveLabel, RESULTS, walk } from "./lib/results.mjs";

const { values: argv } = parseArgs({ options: { label: { type: "string" }, kinds: { type: "string", default: "plan,code" }, force: { type: "boolean", default: false } } });
const cfg = loadConfig();
const label = resolveLabel(argv.label);
const kinds = argv.kinds.split(",").map((k) => k.trim());
const tasks = Object.fromEntries(listTasks().map((t) => [t.dirName, t]));
const RUBRIC = { plan: readText(join(ROOT, "rubric/plan-judge.md")), code: readText(join(ROOT, "rubric/code-judge.md")) };
const MAX_DOC = 90_000;

const repoCache = new Map();
function repoSnapshot(task) {
	if (repoCache.has(task.fixture)) return repoCache.get(task.fixture);
	const files = walk(task.fixtureDir).filter((f) => !f.includes("node_modules"));
	const text = files.map((f) => `### ${f}\n\`\`\`\n${readText(join(task.fixtureDir, f))}\n\`\`\``).join("\n\n");
	repoCache.set(task.fixture, text);
	return text;
}

// Pair runs: same task, model and rep, one per arm.
const runs = listRunDirs(label).filter((r) => existsSync(join(r.dir, "compiled.json")));
const pairs = new Map();
for (const r of runs) {
	const key = `${r.taskDir}|${r.modelSlug}|${r.rep}`;
	if (!pairs.has(key)) pairs.set(key, {});
	pairs.get(key)[r.arm] = r;
}

const outDir = join(RESULTS, label, "judgments");
mkdirSync(outDir, { recursive: true });
const jobs = [];
for (const [key, pair] of pairs) {
	if (!pair.plan || !pair.readyset) continue;
	const [taskDir, slug, rep] = key.split("|");
	for (const kind of kinds) {
		for (const judge of cfg.judge.models) {
			const orders = cfg.judge.swapPositions === false ? ["AB"] : ["AB", "BA"];
			for (const order of orders) jobs.push({ taskDir, slug, rep, kind, judge, order, pair });
		}
	}
}

let done = 0;
const queue = [...jobs];
const workers = Array.from({ length: Math.max(1, cfg.judge.parallel ?? 2) }, async () => {
	while (queue.length) await judgeOne(queue.shift());
});
await Promise.all(workers);
console.log(`judged ${done}/${jobs.length} → results/${label}/judgments/`);

async function judgeOne({ taskDir, slug, rep, kind, judge, order, pair }) {
	const file = join(outDir, taskDir, `${slug}__r${rep}__${kind}__${modelSlug(judge)}__${order}.json`);
	if (existsSync(file) && !argv.force) {
		done++;
		return;
	}
	const task = tasks[taskDir];
	const docOf = (run) => {
		const text = readText(join(run.dir, "judge", kind === "plan" ? "plan.md" : "code.diff"));
		if (!text.trim()) return "(empty — nothing was produced)";
		return text.length > MAX_DOC ? `${text.slice(0, MAX_DOC)}\n… (truncated at ${MAX_DOC} chars)` : text;
	};
	const [first, second] = order === "AB" ? [pair.plan, pair.readyset] : [pair.readyset, pair.plan];
	const prompt = RUBRIC[kind]
		.replace("{{REQUEST}}", () => task.request)
		.replace("{{ACCEPTANCE}}", () => task.acceptance)
		.replace("{{REPO}}", () => repoSnapshot(task))
		.replace("{{A}}", () => docOf(first))
		.replace("{{B}}", () => docOf(second));
	const record = { task: task.id, taskDir, modelSlug: slug, rep: Number(rep), kind, judge, order, positions: { A: first.arm, B: second.arm } };
	try {
		const { json, raw } = await completeJson({ backend: cfg.judge.backend, model: judge, prompt, timeoutSeconds: cfg.judge.timeoutSeconds ?? 600, cfg });
		record.verdict = json;
		record.raw = raw;
		// Map A/B back to arm names so aggregation never has to think about positions.
		record.byArm = Object.fromEntries(
			Object.entries(json.dimensions ?? {}).map(([dim, v]) => [dim, v === "A" ? first.arm : v === "B" ? second.arm : "tie"]),
		);
	} catch (e) {
		record.error = String(e.message ?? e);
	}
	mkdirSync(join(outDir, taskDir), { recursive: true });
	writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
	done++;
	console.log(`${record.error ? "ERR " : "ok  "} ${taskDir} ${slug} r${rep} ${kind} ${judge} ${order}${record.error ? ` — ${record.error.slice(0, 120)}` : ` → overall ${record.byArm?.overall}`}`);
}

void readJson;
