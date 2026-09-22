#!/usr/bin/env node
// Stage 3a — blind pairwise LLM judging of compiled bundles.
// For every (task, model, rep) where both arms ran: each judge model compares the /plan and
// /readyset outputs twice with A/B positions swapped. A dimension counts as a win only when both
// orders agree; disagreement (position bias) is recorded as a tie.
//   kind "plan": normalized planning documents      kind "code": code-only diffs
// Usage: node harness/judge.mjs [--label L] [--kinds plan,code] [--force]
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { loadConfig, listTasks, modelSlug, ROOT } from "./lib/config.mjs";
import { complete, completeJson, isValidVerdict } from "./lib/llm.mjs";
import { listRunDirs, readJson, readText, resolveLabel, RESULTS, walk } from "./lib/results.mjs";

const { values: argv } = parseArgs({
	strict: false,
	options: {
		label: { type: "string" },
		kinds: { type: "string", default: "plan,code" },
		force: { type: "boolean", default: false },
		judges: { type: "string" },
		"length-matched": { type: "boolean", default: false },
	},
});
const cfg = loadConfig();
const label = resolveLabel(argv.label);
const kinds = argv["length-matched"] ? ["plan-lm"] : argv.kinds.split(",").map((k) => k.trim());
const judgeModels = argv.judges ? argv.judges.split(",").map((s) => s.trim()) : cfg.judge.models;
const tasks = Object.fromEntries(listTasks().map((t) => [t.dirName, t]));
const RUBRIC = { plan: readText(join(ROOT, "rubric/plan-judge.md")), code: readText(join(ROOT, "rubric/code-judge.md")) };
RUBRIC["plan-lm"] = RUBRIC.plan;
const MAX_DOC = 90_000;

const repoCache = new Map();
function repoSnapshot(task) {
	if (repoCache.has(task.fixture)) return repoCache.get(task.fixture);
	const files = walk(task.fixtureDir).filter((f) => !f.includes("node_modules"));
	// A bare list of the paths present at base, so a judge does not penalise a plan for citing a
	// real file it believes was invented (seen on T03). Contents follow, in full, below.
	const paths = `### Files present at base (paths only)\n\n${files.map((f) => `- ${f}`).join("\n")}`;
	const text = `${paths}\n\n${files.map((f) => `### ${f}\n\`\`\`\n${readText(join(task.fixtureDir, f))}\n\`\`\``).join("\n\n")}`;
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
	// A harness error is the benchmark's fault, not the workflow's: exclude from judging (it still
	// counts as 0 in the report's intent-to-treat hidden-test figure).
	if ([pair.plan, pair.readyset].some((r) => readJson(join(r.dir, "compiled.json"))?.status === "harness-error")) continue;
	const [taskDir, slug, rep] = key.split("|");
	for (const kind of kinds) {
		for (const judge of judgeModels) {
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
	const task = tasks[taskDir];
	const isPlanDoc = kind === "plan" || kind === "plan-lm";
	const docOf = async (run) => {
		const base = readText(join(run.dir, "judge", isPlanDoc ? "plan.md" : "code.diff"));
		if (!base.trim()) return "(empty — nothing was produced)";
		const text = kind === "plan-lm" ? await lengthMatched(run, base) : base;
		return text.length > MAX_DOC ? `${text.slice(0, MAX_DOC)}\n… (truncated at ${MAX_DOC} chars)` : text;
	};
	// Hash the documents the judge will actually see, so the reuse check is exact.
	const [firstRun, secondRun] = order === "AB" ? [pair.plan, pair.readyset] : [pair.readyset, pair.plan];
	const plainOf = (run) => readText(join(run.dir, "judge", isPlanDoc ? "plan.md" : "code.diff"));
	const docHash = createHash("sha256").update(plainOf(pair.plan)).update("\0").update(plainOf(pair.readyset)).digest("hex").slice(0, 16);
	if (existsSync(file) && !argv.force) {
		const prev = readJson(file);
		// Reuse a verdict only if it is valid and was made on exactly these documents. Invalid
		// verdicts (errored, or malformed like the 4 glm-5.2 records with no `overall`) are re-judged.
		if (prev && !prev.error && prev.status !== "invalid" && prev.byArm && "overall" in prev.byArm && (!prev.docHash || prev.docHash === docHash)) {
			done++;
			return;
		}
	}
	const docA = await docOf(firstRun);
	const docB = await docOf(secondRun);
	const prompt = RUBRIC[kind]
		.replace("{{REQUEST}}", () => task.request)
		.replace("{{ACCEPTANCE}}", () => task.acceptance)
		.replace("{{REPO}}", () => repoSnapshot(task))
		.replace("{{A}}", () => docA)
		.replace("{{B}}", () => docB);
	const record = { task: task.id, taskDir, modelSlug: slug, rep: Number(rep), kind, judge, order, docHash, positions: { A: firstRun.arm, B: secondRun.arm } };
	const retries = cfg.judge.retries ?? 2;
	let verdict = null;
	for (let attempt = 0; attempt <= retries && !verdict; attempt++) {
		try {
			const { json, raw } = await completeJson({ backend: cfg.judge.backend, model: judge, prompt, timeoutSeconds: cfg.judge.timeoutSeconds ?? 600, cfg }, { retries: 0 });
			const check = isValidVerdict(json, RUBRIC[kind]);
			if (!check.ok) {
				record.error = `invalid verdict: ${check.reason}`;
				continue; // retry: a malformed verdict is worth another sample
			}
			verdict = { json, raw };
		} catch (e) {
			record.error = String(e.message ?? e);
			// A hard timeout is not worth retrying: the model already had its full budget, and a
			// retry would only spend the same wall time again (v0.12's eai1 timeout burned 3×600s).
			if (/timed out/i.test(record.error)) break;
		}
	}
	if (verdict) {
		delete record.error;
		record.verdict = verdict.json;
		record.raw = verdict.raw;
		record.status = "ok";
		// Map A/B back to arm names so aggregation never has to think about positions.
		record.byArm = Object.fromEntries(Object.entries(verdict.json.dimensions ?? {}).map(([dim, v]) => [dim, v === "A" ? firstRun.arm : v === "B" ? secondRun.arm : "tie"]));
	} else {
		record.status = "invalid";
		record.error ??= "no verdict after retries";
	}
	mkdirSync(join(outDir, taskDir), { recursive: true });
	writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
	done++;
	const tag = record.status === "ok" ? "ok     " : record.error?.startsWith("invalid verdict") ? "invalid" : "retry  ";
	console.log(`${tag} ${taskDir} ${slug} r${rep} ${kind} ${judge} ${order}${record.status === "ok" ? ` → overall ${record.byArm?.overall}` : ` — ${record.error?.slice(0, 120)}`}`);
}

/**
 * Length-matched planning document: summarise this arm's plan.md toward a fixed character target so
 * both arms are judged at comparable length (LLM judges reward longer documents). Cached per
 * document hash, so re-running is free.
 */
async function lengthMatched(run, text) {
	const target = cfg.judge.lengthMatchChars ?? 8000;
	if (text.length <= target) return text;
	const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
	const cache = join(run.dir, "judge", `plan__lengthmatched_summary__${hash}.json`);
	const cached = readJson(cache);
	if (cached && typeof cached.summary === "string") return cached.summary;
	const prompt = `Summarise the following planning document to at most ${target} characters. Keep every concrete decision, file/function name, and verification step; drop prose, restatement and formatting. Output only the summary.\n\n<document>\n${text.slice(0, 90_000)}\n</document>`;
	const summary = await complete({ backend: cfg.judge.backend, model: cfg.judge.lengthMatchModel ?? cfg.simUser.model, prompt, timeoutSeconds: cfg.judge.timeoutSeconds ?? 600, cfg });
	const trimmed = String(summary).slice(0, target);
	writeFileSync(cache, `${JSON.stringify({ docHash: hash, chars: trimmed.length, summary: trimmed }, null, 2)}\n`);
	return trimmed;
}

void readJson;
