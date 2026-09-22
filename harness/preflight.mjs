#!/usr/bin/env node
// Check everything the benchmark depends on BEFORE spending hours on it. Changes nothing.
//   • omp is on PATH; its version
//   • the readyset extension exists and loads in RPC mode as /readyset
//   • omp accepts the plan arm's flags (--plan-yolo, --plan-yolo-into) in RPC mode
//   • every model in models.txt, the sim-user model and each judge model answers a one-liner
//   • all 12 tasks still validate (hidden tests fail on base, pass on the reference solution)
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadModels, listTasks, readOmpModelConfig, resolveArmModels, ROOT } from "./lib/config.mjs";
import { complete } from "./lib/llm.mjs";
import { OmpRpc } from "./lib/rpc.mjs";
import { prepareRun, sandboxArgs } from "./lib/run-common.mjs";

const cfg = loadConfig();
let problems = 0;
const ok = (msg) => console.log(`  ok   ${msg}`);
const bad = (msg) => {
	problems++;
	console.log(`  FAIL ${msg}`);
};

console.log("omp");
const ver = spawnSync(cfg.omp.bin, ["--version"], { encoding: "utf8" });
ver.status === 0 ? ok(`${cfg.omp.bin} ${ver.stdout.trim()}`) : bad(`${cfg.omp.bin} --version failed: ${ver.stderr || ver.error}`);
const ompCfg = readOmpModelConfig();
ompCfg.found ? ok(`config ${ompCfg.path}: plan=${ompCfg.planModel} default=${ompCfg.defaultModel} readyset=${ompCfg.readysetModel} lang=${ompCfg.readysetLanguage ?? "-"}`) : bad(`no ${ompCfg.path}`);

console.log("\nmodels");
const models = loadModels();
const wanted = new Set();
for (const m of models) for (const arm of ["plan", "readyset"]) {
	const r = resolveArmModels(arm, m);
	wanted.add(r.planModel);
	wanted.add(r.execModel);
}
wanted.add(cfg.simUser.model);
for (const j of cfg.judge.models) wanted.add(j);
for (const m of wanted) {
	try {
		const backend = m === cfg.simUser.model ? cfg.simUser.backend : cfg.judge.models.includes(m) ? cfg.judge.backend : "omp";
		const reply = await complete({ backend, model: m, prompt: "Reply with exactly: OK", timeoutSeconds: 120, cfg });
		/ok/i.test(reply) ? ok(`${m}`) : bad(`${m} replied ${JSON.stringify(reply.slice(0, 80))}`);
	} catch (e) {
		bad(`${m}: ${String(e.message).slice(0, 200)}`);
	}
}

console.log("\nRPC mode");
const scratch = mkdtempSync(join(tmpdir(), "rsb-preflight-"));
writeFileSync(join(scratch, "README.md"), "# preflight\n");
spawnSync("git", ["init", "-q"], { cwd: scratch });
const firstModel = resolveArmModels("plan", models[0] ?? "@config");
await probe("plan arm flags", ["--mode", "rpc", "--cwd", scratch, "--no-extensions", "--no-skills", "--no-session", "--model", firstModel.planModel, "--plan-yolo", "--plan-yolo-into", firstModel.execModel], async () => true);
await probe("readyset extension registers /readyset", ["--mode", "rpc", "--cwd", scratch, "--no-extensions", "-e", cfg.omp.readysetExtension, "--no-skills", "--no-session"], async (rpc) => {
	const data = await rpc.request({ type: "get_available_commands" }, 30000);
	const names = JSON.stringify(data);
	return /"readyset"/.test(names) || names.includes("/readyset");
});
rmSync(scratch, { recursive: true, force: true });

console.log("\nworkspace isolation");
{
	// A workspace must contain the fixture only: no task metadata, no hidden tests, nothing that
	// names the answer. v0.12's leak came from exactly this being reachable (see leak-check.md).
	const scratch = mkdtempSync(join(tmpdir(), "rsb-clean-"));
	const task = listTasks(["T03"])[0];
	const paths = { ws: join(scratch, "repo"), out: join(scratch, "out") };
	try {
		prepareRun(paths, task);
		ok(`workspace for ${task.id} is clean (no task.json / acceptance.md / hidden-tests / reference)`);
	} catch (e) {
		bad(`workspace isolation: ${e.message}`);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
	const sb = sandboxArgs(cfg, "/tmp/does-not-matter");
	sb.length
		? ok(`bwrap sandbox available (${sb.filter((x) => x === "--ro-bind").length} read-only mounts; no network unshare)`)
		: console.log("  note  sandbox disabled or bwrap missing — falling back to the preflight assertion, the sim-user rule and escape logging");
}

console.log("\ntasks");
console.log("  (runs every hidden suite twice — base and reference; ~30-60 s, T12 is a perf test)");
// stdio inherited so each task's line appears as soon as it finishes
const v = spawnSync(process.execPath, [join(ROOT, "scripts/validate-tasks.mjs")], { stdio: "inherit" });
if (v.status !== 0) bad("task validation failed");

console.log(problems ? `\n${problems} problem(s) — fix before running.` : "\nall good — ./run.sh when ready.");
process.exitCode = problems ? 1 : 0;

async function probe(name, args, check) {
	const logs = mkdtempSync(join(tmpdir(), "rsb-probe-"));
	const rpc = new OmpRpc({ bin: cfg.omp.bin, args, cwd: scratch, rawLog: join(logs, "rpc.ndjson"), stderrLog: join(logs, "stderr.txt") });
	try {
		await Promise.race([rpc.ready, new Promise((_, rej) => setTimeout(() => rej(new Error("no ready frame in 60s")), 60000))]);
		(await check(rpc)) ? ok(name) : bad(`${name} (see ${logs})`);
	} catch (e) {
		bad(`${name}: ${e.message} (see ${logs})`);
	} finally {
		await rpc.close();
	}
}
