// Shared plumbing for the two arm drivers.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
	assertCleanWorkspace(paths.ws);
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

/**
 * Task metadata must never live inside the workspace. v0.12 proved why: with an unconfined bash,
 * a run could, and did, cat `tasks/T03-*` json files and read the hidden requirements (see
 * results/v0.12/leak-check.md). prepareRun copies only the fixture, so anything matching these
 * names under the workspace is a harness bug — fail loudly instead of benchmarking a lie.
 */
const FORBIDDEN_IN_WORKSPACE = ["task.json", "acceptance.md", "persona.md", "request.md", "hidden-tests", "reference"];

export function assertCleanWorkspace(ws) {
	const found = [];
	const walkNames = (dir, rel) => {
		for (const name of readdirSync(dir)) {
			const r = rel ? `${rel}/${name}` : name;
			if (FORBIDDEN_IN_WORKSPACE.includes(name)) found.push(r);
			const abs = join(dir, name);
			if (statSync(abs).isDirectory()) walkNames(abs, r);
		}
	};
	if (existsSync(ws)) walkNames(ws, "");
	if (found.length) throw new Error(`workspace is not clean — task metadata is reachable inside it: ${found.join(", ")} (under ${ws})`);
}

/**
 * A `bwrap` argv prefix that confines the agent to its workspace. Absolute paths anywhere else on
 * the host are unmounted, so `find / -name readyset*` cannot reach the bench, the extension's
 * source, ~/Downloads or the session logs. `argv[0]` is the bwrap binary itself, so the result can
 * be handed straight to `OmpRpc`'s `wrap`. Returns [] when disabled or bwrap is missing, in which
 * case the preflight assertion + the sim-user rule + escape logging are the (weaker) fallback.
 */
export function sandboxArgs(cfg, ws) {
	if (cfg.omp?.sandbox === false) return [];
	const bin = "/usr/bin/bwrap";
	if (!existsSync(bin)) return [];
	// The sandbox confines the *agent*. A test double (BENCH_OMP_BIN → a .mjs/.js script, e.g. the
	// offline smoke's fake-omp) is not an executable bwrap can `execvp`, and it may live inside a
	// tree the sandbox deliberately hides. Leave it unconfined: it makes no real model calls.
	const ompBin = resolveOmpBin(cfg.omp?.bin ?? "omp");
	if (/\.(mjs|js|cjs)$/.test(ompBin)) return [];
	const home = homedir();
	const mount = (p) => (existsSync(p) ? ["--ro-bind", p, p] : []);
	const mountRw = (p) => (existsSync(p) ? ["--bind", p, p] : []);
	const ompRoot = (() => {
		try {
			return dirname(realpathSync(ompBin));
		} catch {
			return null;
		}
	})();
	const args = [
		bin,
		...mount("/usr"),
		...mount("/lib"),
		...mount("/lib64"),
		...mount("/bin"),
		...mount("/etc"),
		// The omp binary resolves into a global node_modules tree; mount that tree read-only.
		...mount(home + "/node_modules"),
		...mount(home + "/.bun"),
		// omp opens ~/.omp/agent/*.db read-write (WAL) for the session/history store, so this tree
		// must be a writable bind, not read-only. The run's own session dir is redirected elsewhere
		// (--session-dir into the run output), so no other run's transcript is exposed.
		...mountRw(home + "/.omp"),
		...mount(cfg.omp?.readysetExtension ? extensionRoot(cfg.omp.readysetExtension) : ""),
		...(ompRoot ? mount(ompRoot) : []),
		"--dev",
		"/dev",
		"--proc",
		"/proc",
		"--tmpfs",
		"/tmp",
		"--bind",
		ws,
		ws,
		"--chdir",
		ws,
		"--unshare-pid",
	];
	return args;
}

function resolveOmpBin(bin) {
	if (bin.includes("/")) return bin;
	// `which` without a dependency: walk PATH.
	for (const dir of (process.env.PATH ?? "").split(":")) {
		const p = join(dir, bin);
		if (existsSync(p)) return p;
	}
	return bin;
}

/** The readyset-flow repo directory that holds the extension (`<repo>/src/extensions/x.ts` → `<repo>`). */
function extensionRoot(ext) {
	return resolve(dirname(ext), "..", "..");
}

/**
 * Tool calls recorded in an rpc.ndjson, as `{tool, args}`. Used by the escape tripwire here and by
 * insights.mjs's call-category section; one parser keeps both honest.
 */
export function parseToolCalls(file) {
	if (!existsSync(file)) return [];
	const out = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		let f;
		try {
			f = JSON.parse(line);
		} catch {
			continue;
		}
		if (f.type === "tool_execution_start") out.push({ id: f.toolCallId, tool: f.toolName, args: f.args ?? {} });
	}
	return out;
}

/**
 * Absolute paths a run named outside its workspace, via tool arguments or a bash command. The
 * sandbox is the enforcement; this is the tripwire that proves it held (and catches a sandbox that
 * was disabled). Each arm driver writes the result to metrics.workspaceEscapes.
 */
export function workspaceEscapes(ws, toolCalls) {
	const abs = /(?<![\w.-])\/(?:[\w.-]+\/)*[\w.-]+/g;
	const ignored = [/^\/dev\b/, /^\/proc\b/, /^\/usr\b/, /^\/bin\b/, /^\/lib\b/, /^\/lib64\b/, /^\/etc\b/, /^\/tmp\b/, /^\/session\b/];
	const inWs = (p) => p === ws || p.startsWith(`${ws}/`);
	const out = [];
	for (const call of toolCalls ?? []) {
		const name = call.tool;
		const candidates = [];
		if (name === "bash") {
			if (typeof call.args?.command === "string") candidates.push(...(call.args.command.match(abs) ?? []).map((m) => m.replace(/[;,)]+$/, "")));
		} else if (["read", "edit", "write", "grep", "glob"].includes(name)) {
			const p = call.args?.path;
			if (typeof p === "string" && isAbsolute(p)) candidates.push(p);
		}
		for (const p of candidates) {
			const clean = p.replace(/\/+$/, "");
			if (!clean.startsWith("/")) continue;
			if (inWs(clean) || ignored.some((re) => re.test(clean))) continue;
			out.push({ tool: name, target: clean });
		}
	}
	return out;
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

/**
 * omp's `get_session_stats` token totals, reshaped for metrics.json. NOTE: `total` here is the
 * compaction-sensitive CLIENT counter — it resets when the context is compacted mid-run, so it
 * undercounts long runs, and `subtractTokens(final, prep)` can go negative when prep was measured
 * before a compaction and final after it. Do NOT report this number; compile.mjs derives the
 * canonical total from the raw rpc log instead (harness/lib/tokens.mjs).
 */
export function tokenSummary(stats) {
	if (!stats) return null;
	return { ...stats.tokens, cost: stats.cost ?? 0, toolCalls: stats.toolCalls, assistantMessages: stats.assistantMessages, userMessages: stats.userMessages };
}

/** Element-wise `a - b` over a token summary; see tokenSummary's caveat about the client counter. */
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
