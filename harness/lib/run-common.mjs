// Shared plumbing for the two arm drivers.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, modelSlug } from "./config.mjs";
import { git, makeWorkspace } from "./workspace.mjs";

export function runPaths({ cfg, label, task, arm, model, rep }) {
	const cell = `${arm}__${modelSlug(model)}__r${rep}`;
	const out = join(ROOT, "results", label, task.dirName, cell);
	const ws = join(cfg.workDir, label, task.dirName, cell, "repo");
	return { cell, out, ws };
}

export function prepareRun(paths, task) {
	rmSync(paths.out, { recursive: true, force: true });
	mkdirSync(join(paths.out, "prep"), { recursive: true });
	mkdirSync(join(paths.out, "final"), { recursive: true });
	mkdirSync(join(paths.out, "session"), { recursive: true });
	const baseSha = makeWorkspace(task.fixtureDir, paths.ws);
	// Per-run overlay on top of ~/.omp/agent/config.yml — never edits the user's config. Memory and
	// autolearn are off so no run can learn from a previous one; plan autosave is how the /plan arm's
	// plan is captured at the moment it is approved.
	const overlay = join(paths.out, "omp-overlay.yml");
	writeFileSync(
		overlay,
		[
			"memory:",
			'  backend: "off"',
			"autolearn:",
			"  enabled: false",
			"advisor:",
			"  enabled: false",
			"plan:",
			"  autosave: true",
			`  autosaveDir: ${JSON.stringify(join(paths.out, "prep", "plan-autosave"))}`,
			"",
		].join("\n"),
	);
	return { baseSha, overlay };
}

export function copyIfExists(from, to) {
	if (!existsSync(from)) return false;
	mkdirSync(join(to, ".."), { recursive: true });
	cpSync(from, to, { recursive: true });
	return true;
}

export function listMd(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((f) => f.endsWith(".md"));
}

/** Everything the run changed relative to the base commit, including untracked files. */
export function captureDiff(ws, baseSha) {
	git(ws, ["add", "-A"]);
	const full = git(ws, ["diff", "--cached", baseSha]);
	const stat = git(ws, ["diff", "--cached", "--numstat", baseSha]);
	const status = git(ws, ["status", "--porcelain"]);
	git(ws, ["reset", "-q"], { allowFail: true });
	return { full, stat, status };
}

export function tokenSummary(stats) {
	if (!stats) return null;
	return { ...stats.tokens, cost: stats.cost ?? 0, toolCalls: stats.toolCalls, assistantMessages: stats.assistantMessages, userMessages: stats.userMessages };
}

export function subtractTokens(a, b) {
	if (!a) return null;
	if (!b) return a;
	const out = {};
	for (const k of Object.keys(a)) out[k] = typeof a[k] === "number" ? a[k] - (b[k] ?? 0) : a[k];
	return out;
}

/**
 * Answer an interactive request that came from the agent itself (omp's `ask` tool → RPC
 * select/editor, or a stray confirm) using the simulated user.
 */
export async function answerAgentUi(rpc, frame, simUser, state) {
	const OTHER = /^other\b.*type your own/i;
	if (frame.method === "confirm") {
		rpc.respondUi(frame.id, { confirmed: true });
		return;
	}
	if (frame.method === "input" || frame.method === "editor") {
		const text = await simUser.onInput(frame.title ?? "", state.pendingText);
		state.pendingText = null;
		rpc.respondUi(frame.id, { value: text });
		return;
	}
	if (frame.method !== "select") return;
	const options = frame.options ?? [];
	// Multi-select pickers re-open after each toggle; once we've answered this question, finish it.
	const doneLike = options.find((o) => /^(✓\s*)?(done|submit|confirm|continue|finish)\b/i.test(o.replace(/^[^A-Za-z✓]+/, "")));
	const key = frame.title ?? "";
	if (state.answeredTitles.has(key) && doneLike) {
		rpc.respondUi(frame.id, { value: doneLike });
		return;
	}
	const real = options.filter((o) => !OTHER.test(o));
	const sim = await simUser.onSelect(key, real);
	state.answeredTitles.add(key);
	const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
	let value = options.find((o) => norm(o) === norm(sim.choice)) ?? options.find((o) => sim.choice && norm(o).includes(norm(sim.choice)));
	if (!value && sim.choice && real.length) value = real.find((o) => norm(sim.choice).includes(norm(o)));
	if (!value) {
		const other = options.find((o) => OTHER.test(o));
		if (other && sim.text) {
			state.pendingText = sim.text;
			value = other;
		} else value = real[0] ?? options[0];
	}
	rpc.respondUi(frame.id, { value });
}

export function nowIso() {
	return new Date().toISOString();
}

/** Workflow artefacts, not product code: never counted as "code changed". */
export const WORKFLOW_PATHS = [/^readyset\//, /^\.ai\//, /^\.omp\//, /^PLAN\.md$/i, /^\.fake-answers$/];
export const isWorkflowPath = (p) => WORKFLOW_PATHS.some((re) => re.test(p));

/**
 * captureDiff that never throws. A run whose workspace was damaged (deleted .git, clobbered dir)
 * still gets a metrics.json — with status "harness-error" — instead of vanishing from the results.
 */
export function safeCaptureDiff(ws, baseSha, metrics) {
	try {
		return captureDiff(ws, baseSha);
	} catch (e) {
		metrics.harnessError = `captureDiff: ${String(e.message ?? e).split("\n")[0].slice(0, 300)}`;
		metrics.errors.push(metrics.harnessError);
		return { full: "", stat: "", status: "" };
	}
}

/** Product-code paths in a numstat text (tab-separated add/del/path per line). */
export function codePathsFromNumstat(stat) {
	return stat
		.split("\n")
		.filter(Boolean)
		.map((l) => l.split("\t")[2])
		.filter((p) => p && !isWorkflowPath(p));
}
