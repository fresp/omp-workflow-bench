#!/usr/bin/env node
// Stage 2 — compile every run into a gradeable bundle.
//   • runs the task's hidden tests (and the repo's own suite) against the final code
//   • splits the diff into code vs. workflow artefacts, counts scope, checks plan grounding
//   • writes <run>/compiled.json, <run>/bundle.md, <run>/judge/{plan.md,code.diff}
//   • writes results/<label>/compiled.csv (one row per run)
// Usage: node harness/compile.mjs [--label L] [--force]
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { listTasks } from "./lib/config.mjs";
import { listRunDirs, readJson, readText, resolveLabel, RESULTS, walk } from "./lib/results.mjs";
import { runTestDir } from "./lib/tests.mjs";
import { git, makeWorkspace } from "./lib/workspace.mjs";

const { values: argv } = parseArgs({ options: { label: { type: "string" }, force: { type: "boolean", default: false } } });
const label = resolveLabel(argv.label);
const tasks = Object.fromEntries(listTasks().map((t) => [t.dirName, t]));
import { WORKFLOW_PATHS } from "./lib/run-common.mjs";

const rows = [];
for (const run of listRunDirs(label)) {
	const task = tasks[run.taskDir];
	if (!task) continue;
	let metrics = readJson(join(run.dir, "metrics.json"));
	if (!metrics) {
		// Older runs (before run.mjs wrote stub metrics) can lack metrics.json entirely. Count them.
		metrics = { status: "harness-error", harnessError: "no metrics.json (driver crashed)", errors: [], events: [], model: run.modelSlug };
	}
	const compiledFile = join(run.dir, "compiled.json");
	if (existsSync(compiledFile) && !argv.force) {
		rows.push(readJson(compiledFile));
		continue;
	}

	// ---------- planning document (the "persiapan execution" output) ----------
	const plan = planningDocument(run, metrics);

	// ---------- diff: code vs workflow artefacts ----------
	const fullDiff = readText(join(run.dir, "final", "changes.diff"));
	const numstat = readText(join(run.dir, "final", "numstat.txt"))
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			const [add, del, path] = l.split("\t");
			return { path, add: add === "-" ? 0 : Number(add), del: del === "-" ? 0 : Number(del) };
		});
	const isWorkflow = (p) => WORKFLOW_PATHS.some((re) => re.test(p));
	const codeFiles = numstat.filter((f) => !isWorkflow(f.path));
	const codeDiff = filterDiff(fullDiff, (p) => !isWorkflow(p));
	const isTest = (p) => /(^|\/)test\//.test(p) || /\.test\.m?js$/.test(p);
	const expected = task.expectedTouch ?? [];
	const unexpected = codeFiles.filter((f) => !isTest(f.path) && !expected.some((e) => f.path === e || f.path.startsWith(e.endsWith("/") ? e : `${e}`)));

	// ---------- tests against the final code ----------
	// Grade the code as captured at the end of the run: fixture + final/changes.diff, rebuilt in a
	// scratch dir. Never the live workspace under workDir — /tmp gets cleaned, and a workspace can be
	// clobbered by a later run; the diff in results/ is the authoritative record.
	let hidden = { ran: false, pass: 0, fail: 0, total: 0, failures: [], output: "not graded" };
	let own = { ran: false, pass: 0, fail: 0, total: 0, failures: [], output: "not graded" };
	let gradeError = null;
	{
		const scratch = mkdtempSync(join(tmpdir(), "rsb-grade-"));
		const copy = join(scratch, "repo");
		try {
			makeWorkspace(task.fixtureDir, copy);
			if (fullDiff.trim()) {
				const patch = join(scratch, "changes.diff");
				writeFileSync(patch, fullDiff);
				git(copy, ["apply", "--whitespace=nowarn", "--binary", patch]);
			}
			own = runTestDir(copy, "test");
			rmSync(join(copy, "test", "hidden"), { recursive: true, force: true });
			cpSync(join(task.dir, "hidden-tests"), join(copy, "test", "hidden"), { recursive: true });
			hidden = runTestDir(copy, "test/hidden");
		} catch (e) {
			gradeError = String(e.message ?? e).slice(0, 500);
			hidden.output = own.output = `grading failed: ${gradeError}`;
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}
	const expectedHidden = task.hiddenTestCount ?? hidden.total;
	const hiddenPassRate = expectedHidden ? Math.min(1, hidden.pass / expectedHidden) : 0;

	// ---------- grounding: do paths the plan mentions exist (or get created)? ----------
	const baseFiles = new Set(walk(task.fixtureDir));
	const created = new Set(codeFiles.map((f) => f.path));
	const refs = [...new Set([...plan.raw.matchAll(/(?<![\w/.-])((?:src|test|tests|bin|examples|lib)\/[\w./-]+\.(?:mjs|js|ts|json|md)|README\.md|CHANGELOG\.md|package\.json)/g)].map((m) => m[1]))];
	const grounding = {
		refs: refs.length,
		existing: refs.filter((r) => baseFiles.has(r)).length,
		createdByRun: refs.filter((r) => !baseFiles.has(r) && created.has(r)).length,
		dangling: refs.filter((r) => !baseFiles.has(r) && !created.has(r)),
	};

	const compiled = {
		label,
		task: task.id,
		taskDir: run.taskDir,
		category: task.category,
		clarity: task.clarity,
		arm: run.arm,
		model: metrics.model,
		planModel: metrics.planModel,
		execModel: metrics.execModel,
		rep: run.rep,
		// Runs recorded before bypass detection existed carry gate-not-shown / no-proposal; normalise.
		status: gateBypass(run, metrics, codeFiles) ? "gate-bypassed" : metrics.status,
		harnessError: metrics.status === "harness-error" ? (metrics.harnessError ?? "unknown") : null,
		gateBypass: gateBypass(run, metrics, codeFiles),
		archivedByAgent: Boolean(metrics.archivedByAgent) || (run.arm === "readyset" && !metrics.prepAt && walk(join(run.dir, "final", "readyset", "changes", "archive")).length > 0),
		planSource: plan.source,
		planCaptured: plan.chars > 0,
		planChars: plan.chars,
		hiddenPass: hidden.pass,
		hiddenTotal: expectedHidden,
		hiddenPassRate,
		solved: hidden.pass >= expectedHidden && expectedHidden > 0,
		hiddenFailures: hidden.failures,
		ownSuitePass: own.pass,
		ownSuiteTotal: own.total,
		ownSuiteGreen: own.ran && own.fail === 0 && own.total > 0,
		filesChanged: codeFiles.length,
		linesAdded: codeFiles.reduce((s, f) => s + f.add, 0),
		linesDeleted: codeFiles.reduce((s, f) => s + f.del, 0),
		testFilesChanged: codeFiles.filter((f) => isTest(f.path)).length,
		unexpectedFiles: unexpected.map((f) => f.path),
		codeChangedBeforeApproval: metrics.prepAt ? codeChangedBeforeApproval(metrics.prepWorktreeStatus, isWorkflow) : (gateBypass(run, metrics, codeFiles) ?? []),
		grounding,
		simUserAnswers: metrics.simUserAnswers,
		nudges: metrics.nudges,
		resumes: metrics.resumes ?? 0,
		gateWarnings: metrics.gateWarnings?.length ?? 0,
		verificationSendbacks: metrics.verificationSendbacks ?? 0,
		wallMs: metrics.wallMs,
		prepMs: metrics.prepMs,
		execMs: metrics.execMs,
		tokensPrep: metrics.tokens?.prep?.total ?? null,
		tokensExec: metrics.tokens?.exec?.total ?? null,
		tokensTotal: metrics.tokens?.total?.total ?? null,
		tokensInput: metrics.tokens?.total?.input ?? null,
		tokensCacheRead: metrics.tokens?.total?.cacheRead ?? null,
		tokensOutput: metrics.tokens?.total?.output ?? null,
		cost: metrics.tokens?.total?.cost ?? null,
		toolCalls: metrics.tokens?.total?.toolCalls ?? null,
		routedModels: metrics.routedModels,
		modelDrift: modelDrift(metrics),
		errors: [...(metrics.errors ?? []), ...(gradeError ? [`grading: ${gradeError}`] : [])],
	};

	const judgeDir = join(run.dir, "judge");
	mkdirSync(judgeDir, { recursive: true });
	writeFileSync(join(judgeDir, "plan.md"), normalizeForJudge(plan.raw));
	writeFileSync(join(judgeDir, "code.diff"), codeDiff);
	writeFileSync(join(run.dir, "hidden-tests.txt"), hidden.output);
	writeFileSync(compiledFile, `${JSON.stringify(compiled, null, 2)}\n`);
	writeFileSync(join(run.dir, "bundle.md"), bundle(task, compiled, plan.raw, codeDiff, hidden));
	rows.push(compiled);
	console.log(
		`${run.taskDir.padEnd(28)} ${run.cell.padEnd(40)} ${compiled.status.padEnd(16)} hidden ${hidden.pass}/${expectedHidden}  files ${compiled.filesChanged}  plan ${plan.chars}ch`,
	);
}

writeCsv(join(RESULTS, label, "compiled.csv"), rows);
console.log(`\ncompiled ${rows.length} run(s) → results/${label}/compiled.csv`);

// ---------------------------------------------------------------------------------------------

function planningDocument(run, metrics) {
	const parts = [];
	let source = run.arm === "plan" ? "plan autosave at approval" : "snapshot at review gate";
	if (run.arm === "plan") {
		const dir = join(run.dir, "prep", "plan-autosave");
		for (const f of walk(dir).filter((f) => f.endsWith(".md"))) parts.push({ heading: "Plan", body: readText(join(dir, f)) });
	} else {
		const bdir = existsSync(join(run.dir, "prep", "brainstorms")) ? join(run.dir, "prep", "brainstorms") : join(run.dir, "final", "ai", "brainstorms");
		for (const f of walk(bdir).filter((f) => f.endsWith(".md"))) parts.push({ heading: "Requirements record", body: stripFrontmatter(readText(join(bdir, f))) });
		let cdir = join(run.dir, "prep", "readyset-change");
		let files = walk(cdir);
		if (!files.some((f) => /(^|\/)proposal\.md$/.test(f))) {
			// Gate never reached (bypass / stalled): judge what the agent actually wrote, from the final
			// tree — including changes/archive/ when the agent archived the change itself. Marked as such.
			const fdir = join(run.dir, "final", "readyset", "changes");
			const fFiles = walk(fdir).filter((f) => /(^|\/)(proposal|design|tasks)\.md$|(^|\/)specs\/.*\.md$/.test(f));
			if (fFiles.length) {
				cdir = fdir;
				files = fFiles;
				source = "final (gate never reached)";
			}
		}
		const pick = (re, heading) => files.filter((f) => re.test(f)).forEach((f) => parts.push({ heading, body: readText(join(cdir, f)) }));
		pick(/(^|\/)proposal\.md$/, "Proposal");
		pick(/(^|\/)design\.md$/, "Design");
		pick(/(^|\/)specs\/.*\.md$/, "Specs");
		pick(/(^|\/)tasks\.md$/, "Task list");
	}
	const raw = parts.map((p) => `## ${p.heading}\n\n${p.body.trim()}\n`).join("\n");
	return { raw, chars: raw.length, source: raw ? source : "none" };
}

function stripFrontmatter(text) {
	return text.replace(/^---\n[\s\S]*?\n---\n/, "");
}

/** Remove tool-identifying vocabulary so a judge compares plans, not brands. */
function normalizeForJudge(text) {
	return text
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/readyset\/changes\/[\w.-]+\/?/gi, "<change-dir>/")
		.replace(/\.ai\/brainstorms\/[\w./-]+/gi, "<requirements-doc>")
		.replace(/\bEXPLORATION\.md\b|\bCONTEXT\.md\b|\bREVIEW\.md\b/g, "<notes>")
		.replace(/\bready\s?set\b/gi, "the workflow")
		.replace(/\bplan[- ]yolo\b/gi, "")
		.replace(/\bplan mode\b/gi, "planning")
		.replace(/_Verified:_?/g, "Verified:")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function filterDiff(diff, keep) {
	const chunks = diff.split(/^(?=diff --git )/m);
	return chunks
		.filter((c) => {
			const m = /^diff --git a\/(.+?) b\//.exec(c);
			return m ? keep(m[1]) : false;
		})
		.join("");
}

function codeChangedBeforeApproval(status, isWorkflow) {
	if (!status) return [];
	return status
		.split("\n")
		.filter(Boolean)
		.map((l) => l.slice(3).trim().replace(/^"|"$/g, ""))
		.filter((p) => !isWorkflow(p));
}

function modelDrift(metrics) {
	const routed = Object.keys(metrics.routedModels ?? {});
	if (routed.length === 0) return null;
	const intended = [metrics.planModel, metrics.execModel].map((m) => String(m).split("/").pop().replace(/:.*/, ""));
	const other = routed.filter((r) => !intended.some((i) => r.includes(i)));
	return other.length ? other : null;
}

function bundle(task, c, plan, codeDiff, hidden) {
	return `# ${task.id} — ${task.title}  ·  ${c.arm}  ·  ${c.model}  ·  rep ${c.rep}

| | |
| --- | --- |
| status | ${c.status} |
| hidden tests | ${c.hiddenPass}/${c.hiddenTotal} (${Math.round(c.hiddenPassRate * 100)}%)${c.solved ? " — solved" : ""} |
| repo's own suite | ${c.ownSuitePass}/${c.ownSuiteTotal}${c.ownSuiteGreen ? " green" : ""} |
| code files changed | ${c.filesChanged} (+${c.linesAdded} −${c.linesDeleted}), test files ${c.testFilesChanged} |
| unexpected files | ${c.unexpectedFiles.join(", ") || "—"} |
| code changed before approval | ${c.codeChangedBeforeApproval.join(", ") || "—"} |
| review gate | ${c.gateBypass ? `**BYPASSED** — code changed with no approval: ${c.gateBypass.join(", ")}${c.archivedByAgent ? " (agent also archived the change itself)" : ""}` : c.arm === "readyset" ? "reached" : "n/a"} |
| planning doc source | ${c.planSource} |
| harness error | ${c.harnessError ?? "—"} |
| plan grounding | ${c.grounding.existing} existing + ${c.grounding.createdByRun} created / ${c.grounding.refs} refs; dangling: ${c.grounding.dangling.join(", ") || "—"} |
| sim-user answers / nudges | ${c.simUserAnswers} / ${c.nudges} |
| wall time (prep / exec) | ${fmtMs(c.wallMs)} (${fmtMs(c.prepMs)} / ${fmtMs(c.execMs)}) |
| tokens (prep / exec / total) | ${c.tokensPrep ?? "?"} / ${c.tokensExec ?? "?"} / ${c.tokensTotal ?? "?"} |
| model drift | ${c.modelDrift?.join(", ") ?? "—"} |

## Request

${task.request}

## Planning output

${plan || "_(no planning document captured)_"}

## Hidden test failures

${hidden.failures.length ? hidden.failures.map((f) => `- ${f}`).join("\n") : "_none_"}

## Code diff

\`\`\`diff
${codeDiff.length > 200000 ? `${codeDiff.slice(0, 200000)}\n… (truncated)` : codeDiff}
\`\`\`
`;
}

function fmtMs(ms) {
	if (ms == null) return "?";
	const s = Math.round(ms / 1000);
	return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function writeCsv(file, rows) {
	const cols = ["task", "category", "clarity", "arm", "model", "rep", "status", "hiddenPass", "hiddenTotal", "hiddenPassRate", "solved", "ownSuiteGreen", "filesChanged", "linesAdded", "linesDeleted", "testFilesChanged", "simUserAnswers", "nudges", "wallMs", "prepMs", "execMs", "tokensPrep", "tokensExec", "tokensTotal", "tokensInput", "tokensCacheRead", "tokensOutput", "cost", "planChars", "planSource", "harnessError"];
	const esc = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
	writeFileSync(file, `${cols.join(",")}\n${rows.map((r) => cols.map((c) => esc(r[c])).join(",")).join("\n")}\n`);
}

void git;

/** Product code changed although the readyset review gate was never reached (null for /plan). */
function gateBypass(run, metrics, codeFiles) {
	if (run.arm !== "readyset" || metrics.status === "harness-error") return null;
	if (metrics.prepAt) return null;
	const paths = metrics.gateBypass ?? codeFiles.map((f) => f.path);
	return paths.length ? paths : null;
}
