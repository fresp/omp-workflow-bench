#!/usr/bin/env node
// Stage 1 — run the matrix: task × model × rep × arm. Resumable: a cell with a finished
// metrics.json is skipped unless --force. Arm order alternates per rep so neither arm always
// runs first (time-of-day / provider-load drift is spread across both).
// Usage: node harness/run.mjs [T01 T04 …] [--label L] [--reps N] [--arms plan,readyset] [--models a,b] [--force]
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { listTasks, loadConfig, loadModels, readOmpModelConfig, ROOT } from "./lib/config.mjs";
import { readJson, RESULTS, setLatest } from "./lib/results.mjs";
import { runPaths } from "./lib/run-common.mjs";

const { values: argv, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		label: { type: "string" },
		reps: { type: "string" },
		arms: { type: "string" },
		models: { type: "string" },
		force: { type: "boolean", default: false },
		"dry-run": { type: "boolean", default: false },
		"dirty-workspace": { type: "boolean", default: false },
	},
});
const cfg = loadConfig();
const label = argv.label ?? new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const tasks = listTasks(positionals.length ? positionals : cfg.tasks === "all" || !cfg.tasks ? [] : cfg.tasks);
const models = argv.models ? argv.models.split(",") : loadModels();
const arms = (argv.arms ?? cfg.arms.join(",")).split(",");
const reps = Number(argv.reps ?? cfg.runsPerCell ?? 3);
if (!models.length) throw new Error("models.txt is empty");

const cells = [];
for (let rep = 1; rep <= reps; rep++) {
	for (const task of tasks) {
		for (const model of models) {
			const order = rep % 2 === 1 ? arms : [...arms].reverse();
			for (const arm of order) cells.push({ task, model, arm, rep });
		}
	}
}

mkdirSync(join(RESULTS, label, "logs"), { recursive: true });
if (!argv["dry-run"]) acquireLock(join(RESULTS, label, ".lock"));
setLatest(label);
const manifestFile = join(RESULTS, label, "run-manifest.json");
const manifest = readJson(manifestFile, null) ?? {
	label,
	startedAt: new Date().toISOString(),
	host: hostname(),
	omp: { bin: cfg.omp.bin, version: tryRun(cfg.omp.bin, ["--version"]) },
	readyset: readysetInfo(cfg.omp.readysetExtension),
	ompModelConfig: readOmpModelConfig(),
	config: cfg,
	models,
	tasks: tasks.map((t) => t.id),
	reps,
	arms,
};
// A label can be extended across several invocations (resume, extra reps, re-running one arm), so
// record the omp/readyset versions of every invocation, not just the first.
manifest.invocations ??= [];
manifest.invocations.push({ at: new Date().toISOString(), args: process.argv.slice(2), omp: tryRun(cfg.omp.bin, ["--version"]), readyset: readysetInfo(cfg.omp.readysetExtension) });
manifest.readyset = manifest.invocations.at(-1).readyset;
manifest.lastInvocation = manifest.invocations.at(-1);
writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

const todo = cells.filter((c) => {
	const { out } = runPaths({ cfg, label, task: c.task, arm: c.arm, model: c.model, rep: c.rep });
	const m = readJson(join(out, "metrics.json"));
	return argv.force || !m || m.status === "running";
});
console.log(`label ${label}: ${cells.length} cells (${tasks.length} tasks × ${models.length} models × ${reps} reps × ${arms.length} arms), ${todo.length} to run, parallel ${cfg.parallel ?? 1}`);
if (argv["dry-run"]) {
	for (const c of todo) console.log(`  ${c.task.id} ${c.arm} ${c.model} r${c.rep}`);
	process.exit(0);
}

let finished = 0;
const queue = [...todo];
await Promise.all(Array.from({ length: Math.max(1, cfg.parallel ?? 1) }, worker));
manifest.finishedAt = new Date().toISOString();
writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\ndone. next: ./compile.sh --label ${label} && ./bench.sh --label ${label}`);

async function worker() {
	while (queue.length) {
		const c = queue.shift();
		const script = join(ROOT, "harness", c.arm.startsWith("plan") ? "arm-plan.mjs" : "arm-readyset.mjs");
		const { cell } = runPaths({ cfg, label, task: c.task, arm: c.arm, model: c.model, rep: c.rep });
		const log = createWriteStream(join(RESULTS, label, "logs", `${c.task.id}__${cell}.log`));
		const started = Date.now();
		const extra = [...(c.arm.startsWith("plan") ? [] : ["--arm", c.arm]), ...(argv["dirty-workspace"] ? ["--dirty-workspace"] : [])];
		const code = await new Promise((resolve) => {
			const child = spawn(process.execPath, [script, "--task", c.task.id, "--model", c.model, "--rep", String(c.rep), "--label", label, ...extra], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
			child.stdout.pipe(log, { end: false });
			child.stderr.pipe(log, { end: false });
			child.on("close", resolve);
		});
		log.end();
		finished++;
		const { out } = runPaths({ cfg, label, task: c.task, arm: c.arm, model: c.model, rep: c.rep });
		let m = readJson(join(out, "metrics.json"));
		if (!m) {
			// The driver died before writing metrics. Record the cell anyway, so it is counted (as a
			// harness error) instead of silently disappearing from every denominator downstream.
			m = {
				arm: c.arm,
				task: c.task.id,
				model: c.model,
				rep: c.rep,
				status: "harness-error",
				harnessError: `driver exited ${code} without metrics.json — see logs/${c.task.id}__${cell}.log`,
				errors: [],
				events: [],
				startedAt: new Date(started).toISOString(),
				finishedAt: new Date().toISOString(),
				wallMs: Date.now() - started,
			};
			mkdirSync(out, { recursive: true });
			writeFileSync(join(out, "metrics.json"), `${JSON.stringify(m, null, 2)}\n`);
		}
		console.log(`[${finished}/${todo.length}] ${c.task.id} ${c.arm.padEnd(8)} ${c.model} r${c.rep} → ${m.status} (${Math.round((Date.now() - started) / 1000)}s)`);
	}
}

function tryRun(bin, args) {
	const r = spawnSync(bin, args, { encoding: "utf8" });
	return r.status === 0 ? r.stdout.trim() : null;
}

function readysetInfo(ext) {
	if (!ext || !existsSync(ext)) return { extension: ext, found: false };
	const repo = join(ext, "..", "..", "..");
	const pkg = readJson(join(repo, "package.json"), {});
	const sha = spawnSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout?.trim();
	const dirty = spawnSync("git", ["-C", repo, "status", "--porcelain", "--", "src"], { encoding: "utf8" }).stdout?.trim();
	return { extension: ext, found: true, version: pkg.version, gitSha: sha || null, srcDirty: Boolean(dirty) };
}

/**
 * One run process per label. Two processes on the same label share workspaces and delete each
 * other's repos (seen in deepseek-r1: T03/T06/T07 lost their .git). A lock left by a dead process
 * (same host, pid gone) is taken over; a live one aborts this run.
 */
function acquireLock(file) {
	if (existsSync(file)) {
		let holder = {};
		try {
			holder = JSON.parse(readFileSync(file, "utf8"));
		} catch {}
		let alive = false;
		if (holder.host === hostname() && holder.pid) {
			try {
				process.kill(holder.pid, 0);
				alive = true;
			} catch {}
		} else if (holder.pid) {
			alive = true; // another host: can't check, don't steal it
		}
		if (alive) {
			console.error(`label ${label} is already being run by pid ${holder.pid} on ${holder.host} since ${holder.at}.`);
			console.error(`Wait for it, stop it, or delete ${file} if you are sure it is gone.`);
			process.exit(3);
		}
		console.log(`taking over stale lock from pid ${holder.pid}`);
	}
	writeFileSync(file, JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }));
	const release = () => {
		try {
			const cur = JSON.parse(readFileSync(file, "utf8"));
			if (cur.pid === process.pid) rmSync(file, { force: true });
		} catch {}
	};
	process.on("exit", release);
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
		process.on(sig, () => {
			release();
			process.exit(130);
		});
	}
}
