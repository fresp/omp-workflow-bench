// Shared plumbing for the two arm drivers.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ROOT, modelSlug } from "./config.mjs";
import { stageExtension } from "./ext-stage.mjs";
import { git, makeWorkspace } from "./workspace.mjs";

export function runPaths({ cfg, label, task, arm, model, rep }) {
	const cell = `${arm}__${modelSlug(model)}__r${rep}`;
	const out = join(ROOT, "results", label, task.dirName, cell);
	const ws = join(cfg.workDir, label, task.dirName, cell, "repo");
	return { cell, out, ws };
}

export function prepareRun(paths, task, { dirty = false, extPath = null } = {}) {
	rmSync(paths.out, { recursive: true, force: true });
	mkdirSync(join(paths.out, "prep"), { recursive: true });
	mkdirSync(join(paths.out, "final"), { recursive: true });
	mkdirSync(join(paths.out, "session"), { recursive: true });
	const baseSha = makeWorkspace(task.fixtureDir, paths.ws);
	assertCleanWorkspace(paths.ws);
	// Stage a minimal, neutral-named copy of the extension into the run output dir. The output dir is
	// not mounted into the sandbox, so the source repo stays invisible under a name without "readyset";
	// the arm drivers pass the staged entry to `-e` and sandboxArgs binds the staged root.
	const stagedExtension = extPath ? stageExtension(extPath, join(paths.out, "ext")) : null;
	// F1: pre-dirty the workspace like a user mid-edit, before the base commit is captured by the
	// driver's diff. (The base commit already exists; the dirty files show up as uncommitted changes,
	// which is exactly what a real working tree looks like.)
	const userEdits = dirty ? dirtyWorkspace(paths.ws, task) : null;
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
	return { baseSha, overlay, userEdits, stagedExtension };
}

export function copyIfExists(from, to) {
	if (!existsSync(from)) return false;
	mkdirSync(join(to, ".."), { recursive: true });
	cpSync(from, to, { recursive: true });
	return true;
}

/**
 * F1 dirty-workspace test: make the workspace look like a working tree a real user was mid-edit in,
 * then record the bytes+hashes of every file we touched. The driver re-checks them after the run and
 * sets metrics.userEditsPreserved / metrics.userEditsDetail. One file the task is expected to touch,
 * one it is not, and one untracked user file. `hunk` is the exact text we inserted (or the whole
 * content for a new file): the expected-touch file may legitimately be edited by the agent, so its
 * verdict is "the user's hunk is still present", not byte-identity.
 * @returns {Array<{path:string, sha256:string, kind:string, hunk:string}>}
 */
export function dirtyWorkspace(ws, task) {
	const expected = (task.expectedTouch ?? []).find((p) => existsSync(join(ws, p)));
	const allFiles = [];
	const walkWs = (dir, rel = "") => {
		for (const name of readdirSync(join(dir, rel))) {
			const r = rel ? `${rel}/${name}` : name;
			if (statSync(join(dir, r)).isDirectory()) {
				if (name !== ".git" && name !== "node_modules") walkWs(dir, r);
			} else allFiles.push(r);
		}
	};
	walkWs(ws);
	const untouched = allFiles.find((f) => !expected?.startsWith?.(f) && f !== expected && !(task.expectedTouch ?? []).includes(f));
	const edits = [];
	const record = (rel, content, kind, hunk) => {
		const p = join(ws, rel);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, content);
		edits.push({ path: rel, sha256: createHash("sha256").update(content).digest("hex"), kind, hunk });
	};
	const note = "\n// user was editing this before the run\n";
	const otherNote = "\n// user note left mid-edit\n";
	const untrackedNote = `# my notes\n\nremember: ship it\n`;
	if (expected) record(expected, `${readFileSync(join(ws, expected), "utf8")}${note}`, "expected-touch", note);
	if (untouched) record(untouched, `${readFileSync(join(ws, untouched), "utf8")}${otherNote}`, "unexpected-touch", otherNote);
	record(".user-notes.md", untrackedNote, "untracked", untrackedNote);
	return edits;
}

/**
 * Per-kind verdict on the pre-dirtied user files after the run:
 *   expected-touch   — the task legitimately edits this file, so pass iff the user's recorded hunk
 *                      is still present (the agent may edit around it).
 *   unexpected-touch — the task must not touch this file: byte-identical (missing = fail).
 *   untracked        — the user's own file: byte-identical (missing = fail).
 * Returns null when nothing was recorded, else {preserved, detail:[{kind, pass}]}.
 */
export function verifyUserEdits(ws, edits) {
	if (!edits?.length) return null;
	const detail = edits.map((e) => {
		const p = join(ws, e.path);
		if (!existsSync(p)) return { kind: e.kind, pass: false };
		if (e.kind === "expected-touch") return { kind: e.kind, pass: readFileSync(p, "utf8").includes(e.hunk) };
		return { kind: e.kind, pass: createHash("sha256").update(readFileSync(p)).digest("hex") === e.sha256 };
	});
	return { preserved: detail.every((d) => d.pass), detail };
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
 * The current cell's output dir, bound into the sandbox at a neutral path.
 *
 * Why: the arm drivers pass omp `--config <cell>/omp-overlay.yml`, `-e <cell>/ext/src/…` and
 * `--session-dir <cell>/session` — all under the bench root, which the sandbox deliberately does
 * not mount. qc-1's omp therefore died at startup with
 * `Config overlay not found: …/results/qc-1/…/omp-overlay.yml` (see that run's omp-stderr.txt),
 * never printed a `ready` frame and left an empty rpc.ndjson. Binding the *cell* — and nothing
 * else under the bench root — at a neutral in-sandbox path fixes that without exposing `tasks/`,
 * other cells or other labels.
 */
export const CELL_SANDBOX_ROOT = "/run/cell";
/**
 * @returns {{host:string, sandbox:string}|null} null when no sandbox is in play.
 */
export const cellMount = (cfg, out) => (useSandbox(cfg) ? { host: resolve(out), sandbox: CELL_SANDBOX_ROOT } : null);

/** The in-sandbox extension root for a cell mount (`<staged>/src/…` sits under this). */
export const cellExtensionRoot = (cell) => (cell ? join(cell.sandbox, "ext") : null);

/** Absolute `host` → its in-sandbox path under the cell mount, or unchanged when `host` is outside it. */
export function toSandboxPath(mount, host) {
	if (!mount) return host;
	const h = resolve(host);
	return h === mount.host || h.startsWith(`${mount.host}/`) ? join(mount.sandbox, h.slice(mount.host.length)) : h;
}

/**
 * Is a sandbox in effect for this config? `BENCH_BWRAP_BIN` is a smoke-only override in the spirit
 * of BENCH_OMP_BIN/BENCH_WORK_DIR; production leaves it unset and gets /usr/bin/bwrap. Set, it also
 * disables the .mjs test-double escape hatch below: the offline smoke's fake omp then runs through
 * a bwrap-shaped argv (its shim), which is the only offline way to exercise the mount assembly and
 * the arg rewriting.
 */
function useSandbox(cfg) {
	if (cfg.omp?.sandbox === false) return false;
	const bwrapBin = process.env.BENCH_BWRAP_BIN ?? "/usr/bin/bwrap";
	if (!existsSync(bwrapBin)) return false;
	// A test double (BENCH_OMP_BIN → a .mjs/.js script) is not an executable bwrap can `execvp`.
	// Only when bwrap is the real thing: with BENCH_BWRAP_BIN set (the offline smoke's shim, which
	// execs its argv without confinement) the double *is* what we want to run through the wrapper.
	return process.env.BENCH_BWRAP_BIN ? true : !/\.(mjs|js|cjs)$/.test(resolveOmpBin(cfg.omp?.bin ?? "omp"));
}

/**
 * A `bwrap` argv prefix that confines the agent to its workspace. Absolute paths anywhere else on
 * the host are unmounted, so `find / -name readyset*` cannot reach the bench, the extension's
 * source, ~/Downloads or the session logs.
 *
 * The cell's output dir (overlay, staged extension, session dir) is the *only* thing under the
 * bench root the sandbox can see, bound read-only at `/run/cell`; the bench root, `tasks/`, every
 * other cell and every other label are not mounted. The drivers rewrite the paths they hand to omp
 * accordingly (see `toSandboxPath`).
 *
 * When `stagedExtension` is given, only its staged root (`<staged>/src/…`) is bound, so the sandbox
 * never exposes the extension's full source repo. Without it (e.g. preflight, which probes before
 * any run) the real extension root is bound, as before.
 *
 * `argv[0]` is the (possibly BENCH_BWRAP_BIN-overridden) bwrap binary itself, so the result can be
 * handed straight to `OmpRpc`'s `wrap`. Returns [] when disabled or bwrap is missing, in which case
 * the preflight assertion + the sim-user rule + escape logging are the (weaker) fallback.
 */
export function sandboxArgs(cfg, ws, stagedExtension = null, cell = null) {
	if (!useSandbox(cfg)) return [];
	const bin = process.env.BENCH_BWRAP_BIN ?? "/usr/bin/bwrap";
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
	// The extension root the sandbox may see: the staged copy's root when staging is in effect, else
	// the real extension repo (preflight probe).
	const extMountRoot = stagedExtension
		? dirname(dirname(dirname(stagedExtension)))
		: cfg.omp?.readysetExtension
			? extensionRoot(cfg.omp.readysetExtension)
			: null;
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
		...(extMountRoot ? mount(extMountRoot) : []),
		...(ompRoot ? mount(ompRoot) : []),
		// The current cell's output dir, and only that, of the bench root.
		...(cell ? ["--ro-bind", cell.host, cell.sandbox] : []),
		"--dev",
		"/dev",
		"--proc",
		"/proc",
		// A *read-only* /tmp (the previous `mount("/tmp")`) made every scratch write fail — observed
		// while reproducing: `bwrap … /bin/sh -c 'echo x > /tmp/y'` → `Read-only file system` — and a
		// read-only bind of the whole host tmpfs is exactly the wrong thing for a confinement whose
		// job is to hide other runs. The workspace is mounted by its own explicit bind, so an empty
		// writable /tmp is enough.
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
 *
 * When `extPath` is given, an escape whose cleaned target is inside the extension's source tree is
 * tagged `category: "extension-src"` (the extension's own files are readable from the workspace's
 * host side unless the sandbox mounts a copy); every other escape is `category: "other"`.
 *
 * Under the cell mount the agent sees the *staged* copy at `/run/cell/ext/src/extensions/<name>.ts`,
 * while the drivers still pass the real extension path — so `extMountRoot` (the in-sandbox staged
 * root, `cellExtensionRoot(cell)`) counts as extension-src too. A tool call naming anything else
 * under `/run/cell` (the overlay, the session dir) is a genuine escape attempt and stays `"other"`.
 */
export function workspaceEscapes(ws, toolCalls, extPath = null, extMountRoot = null) {
	const abs = /(?<![\w.-])\/(?:[\w.-]+\/)*[\w.-]+/g;
	const ignored = [/^\/dev\b/, /^\/proc\b/, /^\/usr\b/, /^\/bin\b/, /^\/lib\b/, /^\/lib64\b/, /^\/etc\b/, /^\/tmp\b/, /^\/session\b/];
	const inWs = (p) => p === ws || p.startsWith(`${ws}/`);
	const root = extPath && isAbsolute(extPath) ? extensionRoot(extPath) : null;
	const inExt = (p) => (root != null && (p === root || p.startsWith(`${root}/`))) || (extMountRoot != null && (p === extMountRoot || p.startsWith(`${extMountRoot}/`)));
	const out = [];
	for (const call of toolCalls ?? []) {
		const name = call.tool;
		const candidates = [];
		if (name === "bash") {
			if (typeof call.args?.command === "string") {
				const cmd = call.args.command;
				for (const m of cmd.matchAll(abs)) {
					const prev = m.index > 0 ? cmd[m.index - 1] : "";
					if (prev && /[()\[\]{}*%+-]/.test(prev)) continue;
					const tok = m[0].replace(/[;,)]+$/, "");
					if (/^\/\d+(\/|$)/.test(tok)) continue;
					candidates.push(tok);
				}
			}
		} else if (["read", "edit", "write", "grep", "glob"].includes(name)) {
			const p = call.args?.path;
			if (typeof p === "string" && isAbsolute(p)) candidates.push(p);
		}
		for (const p of candidates) {
			const clean = p.replace(/\/+$/, "");
			if (!clean.startsWith("/")) continue;
			if (inWs(clean) || ignored.some((re) => re.test(clean))) continue;
			out.push({ tool: name, target: clean, category: inExt(clean) ? "extension-src" : "other" });
		}
	}
	return out;
}

export function listMd(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((f) => f.endsWith(".md"));
}

/**
 * True when a bash command writes a file. Used by insights.mjs's section 7 so a file edited through
 * `sed -i`, a redirect, a heredoc or an inline `node`/`python` script counts as an edit for the
 * repeat-test bookkeeping — the agent can change a repo file without ever calling `edit`/`write`.
 *
 * Detected: `sed -i`, `tee <path>`, output redirection into a path (`>` / `>>`, which also covers
 * `cat > file <<EOF` and `cat <<EOF > file`), `writeFileSync`/`appendFileSync`, `open(<path>, "w")`,
 * and `python -c` scripts that write.
 * Excluded: redirections whose target is under /dev, /proc or /tmp (throwaway probes, not repo
 * files — v0.12's runs wrote short-lived scripts there), and a bare `printf`/`echo` to stdout.
 */
export function isBashEdit(command) {
	const cmd = String(command ?? "");
	if (!cmd) return false;
	const isThrowaway = (p) => /^\s*\/(dev|proc|tmp)\b/.test(p);
	// A redirection target: `> path`, `>> path`, `2> path`, `>| path`. The `(?<![=\-<])` lookbehind
	// stops JavaScript/Python arrows (`=>`, `->`) and comparison (`<`) from reading as a redirect.
	// `>&1`/`>&2` are fd dups (excluded by the `[^&|]` target).
	const redirected = [...cmd.matchAll(/(?<![=\-<])[0-9]?>>?\|?\s*([^&|\s;]+)/g)].map((m) => m[1]).filter((p) => !isThrowaway(p));
	if (redirected.length) return true;
	const teeTargets = [...cmd.matchAll(/\btee\b((?:\s+-[a-zA-Z]+)*)\s+([^|;&\s]+)/g)].map((m) => m[2]).filter((p) => !isThrowaway(p));
	if (teeTargets.length) return true;
	if (/\bsed\b[^|;&]*\s-i(\s|$|\b)/.test(cmd)) return true;
	// perl -i / -pi edit a file in place, exactly like sed -i.
	if (/\bperl\b[^|;&]*\s-[a-zA-Z0-9]*i[a-zA-Z0-9]*\s/.test(cmd)) return true;
	if (/writeFileSync\s*\(|appendFileSync\s*\(/.test(cmd)) return true;
	if (/open\s*\(\s*[^)]*,\s*["'`][wa]\+?["'`]/.test(cmd)) return true;
	if (/\bpython[0-9.]*\b/.test(cmd) && /with\s+open\s*\(|\.write\s*\(|open\s*\([^)]*["'`]w/.test(cmd)) return true;
	return false;
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

/**
 * Product-code paths that changed beyond the files the harness itself wrote for --dirty-workspace.
 * The dirtied files are uncommitted by construction, so they always appear in the run's diff; without
 * subtracting them every --dirty-workspace run of the readyset arm is reported as gate-bypassed even
 * when the agent never touched the repo (qc-1: gateBypass = [".user-notes.md", "README.md",
 * "src/services/pricing.mjs"], the three files dirtyWorkspace() had just written).
 * An entry is subtracted when its path matches the recorded edit AND its recorded sha256 (or, for the
 * expected-touch file the agent may legitimately edit, its recorded hunk) is unchanged in `ws`.
 * @param {string} ws workspace root
 * @param {Array<{path:string, sha256:string, kind:string, hunk:string}>} userEdits dirtyWorkspace() output
 * @param {string[]} codePaths product-code paths from the run's numstat
 */
export function userEditCodePaths(ws, userEdits, codePaths) {
	if (!userEdits?.length) return codePaths;
	const unchanged = (e) => {
		const p = join(ws, e.path);
		if (!existsSync(p)) return false;
		if (e.kind === "expected-touch") return readFileSync(p, "utf8").includes(e.hunk);
		return createHash("sha256").update(readFileSync(p)).digest("hex") === e.sha256;
	};
	const own = new Set(userEdits.filter(unchanged).map((e) => e.path));
	return codePaths.filter((p) => !own.has(p));
}
