#!/usr/bin/env node
// Arm A — native omp plan mode, headless: `omp --mode rpc --plan-yolo --plan-yolo-into <exec model>`.
// The agent plans in read-only plan mode (it may ask the user via the ask tool — answered by the
// simulated user), its approved plan is auto-accepted exactly like pressing Approve, and it then
// implements the plan in the same session.
//
// Usage: node harness/arm-plan.mjs --task T01 --model <spec> --rep 1 --label <run-label>
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, loadTask, listTasks, resolveArmModels } from "./lib/config.mjs";
import { OmpRpc } from "./lib/rpc.mjs";
import { createSimUser } from "./lib/sim-user.mjs";
import { answerAgentUi, listMd, parseToolCalls, safeCaptureDiff, sandboxArgs, nowIso, prepareRun, runPaths, subtractTokens, tokenSummary, verifyUserEdits, workspaceEscapes } from "./lib/run-common.mjs";
import { git } from "./lib/workspace.mjs";

const { values: argv } = parseArgs({ options: { task: { type: "string" }, model: { type: "string" }, rep: { type: "string", default: "1" }, label: { type: "string" }, "dirty-workspace": { type: "boolean", default: false } } });
const cfg = loadConfig();
const task = loadTask(listTasks([argv.task])[0].dirName);
const models = resolveArmModels("plan", argv.model);
const paths = runPaths({ cfg, label: argv.label, task, arm: "plan", model: argv.model, rep: argv.rep });
const { baseSha, overlay, userEdits } = prepareRun(paths, task, { dirty: argv["dirty-workspace"] });

const metrics = {
	arm: "plan",
	task: task.id,
	model: argv.model,
	planModel: models.planModel,
	execModel: models.execModel,
	modelSource: models.source,
	rep: Number(argv.rep),
	workspace: paths.ws,
	baseSha,
	status: "running",
	startedAt: nowIso(),
	prepAt: null,
	finishedAt: null,
	simUserAnswers: 0,
	nudges: 0,
	uiRequests: 0,
	events: [],
	errors: [],
};
const event = (what, extra = {}) => metrics.events.push({ at: nowIso(), what, ...extra });

const args = [
	"--mode", "rpc",
	"--cwd", paths.ws,
	"--config", overlay,
	"--no-extensions",
	"--no-skills",
	"--session-dir", join(paths.out, "session"),
	"--model", models.planModel,
	"--plan-yolo",
	"--plan-yolo-into", models.execModel,
	...cfg.omp.extraArgs,
];
metrics.ompArgs = args;

const rpc = new OmpRpc({ bin: cfg.omp.bin, args, cwd: paths.ws, rawLog: join(paths.out, "rpc.ndjson"), stderrLog: join(paths.out, "omp-stderr.txt"), wrap: sandboxArgs(cfg, paths.ws) });
const simUser = createSimUser({ task, cfg, logFile: join(paths.out, "sim-user.ndjson") });
const uiState = { answeredTitles: new Set(), pendingText: null };
const deadline = Date.now() + cfg.limits.runMinutes * 60_000;
const autosaveDir = join(paths.out, "prep", "plan-autosave");
let busy = 0;
let prepared = false;
let prepStats = null;

async function markPrepared(reason) {
	if (prepared) return;
	prepared = true;
	metrics.prepAt = nowIso();
	event("plan-approved", { reason });
	prepStats = await rpc.stats();
	// Plan mode is read-only; record anything that nevertheless changed before approval.
	metrics.prepWorktreeStatus = git(paths.ws, ["status", "--porcelain"]);
}

rpc.on("frame", (frame) => {
	if (!prepared && /plan approved|Plan approved/.test(JSON.stringify(frame).slice(0, 4000))) void markPrepared("notice");
	if (frame.type !== "extension_ui_request" || !["select", "confirm", "input", "editor"].includes(frame.method)) return;
	metrics.uiRequests++;
	busy++;
	answerAgentUi(rpc, frame, simUser, uiState)
		.catch((e) => {
			metrics.errors.push(`ui: ${e.message}`);
			rpc.respondUi(frame.id, { cancelled: true });
		})
		.finally(() => busy--);
});
rpc.on("spawn-error", (e) => metrics.errors.push(`spawn: ${e.message}`));

// The approved plan is autosaved the moment plan mode hands off to implementation.
const autosaveWatch = setInterval(() => {
	if (!prepared && listMd(autosaveDir).length > 0) void markPrepared("autosave");
}, 1000);

async function main() {
	await Promise.race([rpc.ready, new Promise((_, rej) => setTimeout(() => rej(new Error("omp did not become ready in 120s")), 120_000))]);
	event("ready");
	rpc.prompt(task.request);
	event("prompt-sent");

	for (;;) {
		const idle = await rpc.waitIdle({ quietMs: cfg.limits.idleSeconds * 1000, deadline, isBusy: () => busy > 0 });
		if (!prepared && listMd(autosaveDir).length > 0) await markPrepared("autosave");
		if (idle !== "idle") {
			metrics.status = idle === "timeout" ? "timeout" : "omp-exited";
			return;
		}
		const text = (await rpc.lastAssistantText()) ?? "";
		const canAnswer = simUser.answers < cfg.limits.maxSimUserAnswers;
		const verdict = text && canAnswer ? await simUser.onAgentMessage(text) : { needsReply: false };
		if (verdict.needsReply) {
			event("sim-user-reply");
			rpc.prompt(verdict.reply);
			continue;
		}
		if (prepared) {
			metrics.status = "done";
			return;
		}
		if (metrics.nudges >= cfg.limits.maxNudges) {
			metrics.status = "no-plan";
			return;
		}
		metrics.nudges++;
		event("nudge");
		rpc.prompt("Please continue.");
	}
}

try {
	await main();
} catch (e) {
	metrics.status = "error";
	metrics.errors.push(String(e.stack ?? e));
}

clearInterval(autosaveWatch);
const finalStats = await rpc.stats();
try {
	const messages = await rpc.request({ type: "get_messages" }, 60_000);
	writeFileSync(join(paths.out, "messages.json"), JSON.stringify(messages, null, 1));
} catch (e) {
	metrics.errors.push(`get_messages: ${e.message}`);
}
await rpc.close();

const diff = safeCaptureDiff(paths.ws, baseSha, metrics);
writeFileSync(join(paths.out, "final", "changes.diff"), diff.full);
writeFileSync(join(paths.out, "final", "numstat.txt"), diff.stat);
metrics.workspaceEscapes = workspaceEscapes(paths.ws, parseToolCalls(join(paths.out, "rpc.ndjson")));
metrics.userEdits = userEdits;
metrics.userEditsPreserved = verifyUserEdits(paths.ws, userEdits);

if (metrics.harnessError) metrics.status = "harness-error";
metrics.finishedAt = nowIso();
metrics.simUserAnswers = simUser.answers;
metrics.planCaptured = listMd(autosaveDir).length > 0;
metrics.tokens = {
	prep: tokenSummary(prepStats) ?? tokenSummary(finalStats),
	exec: prepStats ? subtractTokens(tokenSummary(finalStats), tokenSummary(prepStats)) : null,
	total: tokenSummary(finalStats),
};
metrics.routedModels = finalStats?.routedModels ?? null;
metrics.wallMs = Date.parse(metrics.finishedAt) - Date.parse(metrics.startedAt);
metrics.prepMs = metrics.prepAt ? Date.parse(metrics.prepAt) - Date.parse(metrics.startedAt) : null;
metrics.execMs = metrics.prepAt ? Date.parse(metrics.finishedAt) - Date.parse(metrics.prepAt) : null;
writeFileSync(join(paths.out, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
console.log(`plan[${task.id} ${argv.model} r${argv.rep}] ${metrics.status} — ${Math.round(metrics.wallMs / 1000)}s, sim-user answers ${metrics.simUserAnswers}`);
process.exit(existsSync(join(paths.out, "metrics.json")) ? 0 : 1);
