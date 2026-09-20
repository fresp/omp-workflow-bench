#!/usr/bin/env node
// Arm B — /readyset, headless over RPC with only the readyset extension loaded.
//   1. `/readyset --idea '<request>'` → Grill (questions answered by the simulated user) → brainstorm file
//   2. `/readyset --fast --model <m>` → pick that brainstorm → Explore → Propose → review gate
//   3. gate: Approve & Execute (same as the /plan arm's auto-approve) → Apply → Code review → "Not yet"
//
// Usage: node harness/arm-readyset.mjs --task T01 --model <spec> --rep 1 --label <run-label>
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, loadTask, listTasks, resolveArmModels } from "./lib/config.mjs";
import { OmpRpc } from "./lib/rpc.mjs";
import { createSimUser } from "./lib/sim-user.mjs";
import { answerAgentUi, captureDiff, copyIfExists, listMd, nowIso, prepareRun, runPaths, subtractTokens, tokenSummary } from "./lib/run-common.mjs";
import { git } from "./lib/workspace.mjs";

const { values: argv } = parseArgs({ options: { task: { type: "string" }, model: { type: "string" }, rep: { type: "string", default: "1" }, label: { type: "string" } } });
const cfg = loadConfig();
const task = loadTask(listTasks([argv.task])[0].dirName);
const models = resolveArmModels("readyset", argv.model);
const paths = runPaths({ cfg, label: argv.label, task, arm: "readyset", model: argv.model, rep: argv.rep });
const { baseSha, overlay } = prepareRun(paths, task);

if (!cfg.omp.readysetExtension || !existsSync(cfg.omp.readysetExtension)) {
	console.error(`readyset extension not found: ${cfg.omp.readysetExtension} (bench.config.json → omp.readysetExtension)`);
	process.exit(2);
}

const metrics = {
	arm: "readyset",
	task: task.id,
	model: argv.model,
	planModel: models.planModel,
	execModel: models.execModel,
	modelSource: models.source,
	rep: Number(argv.rep),
	workspace: paths.ws,
	baseSha,
	status: "running",
	phase: "grill",
	startedAt: nowIso(),
	brainstormAt: null,
	prepAt: null,
	finishedAt: null,
	simUserAnswers: 0,
	nudges: 0,
	resumes: 0,
	uiRequests: 0,
	gateWarnings: [],
	verificationSendbacks: 0,
	unexpectedUi: [],
	events: [],
	errors: [],
};
const event = (what, extra = {}) => metrics.events.push({ at: nowIso(), what, ...extra });

const args = [
	"--mode", "rpc",
	"--cwd", paths.ws,
	"--config", overlay,
	// Hermetic: the extension under test is the only one loaded. --no-skills matters: a `readyset`
	// skill is also installed, and skills resolve before extension commands in RPC mode.
	"--no-extensions",
	"-e", cfg.omp.readysetExtension,
	"--no-skills",
	"--session-dir", join(paths.out, "session"),
	"--model", models.planModel,
	...cfg.omp.extraArgs,
];
metrics.ompArgs = args;

const rpc = new OmpRpc({ bin: cfg.omp.bin, args, cwd: paths.ws, rawLog: join(paths.out, "rpc.ndjson"), stderrLog: join(paths.out, "omp-stderr.txt") });
const simUser = createSimUser({ task, cfg, logFile: join(paths.out, "sim-user.ndjson") });
const uiState = { answeredTitles: new Set(), pendingText: null };
const deadline = Date.now() + cfg.limits.runMinutes * 60_000;
const brainstormDir = join(paths.ws, ".ai", "brainstorms");
let busy = 0;
let prepStats = null;
let pipelineDone = false;

function changeIds() {
	const dir = join(paths.ws, "readyset", "changes");
	return existsSync(dir) ? readdirSync(dir).filter((d) => d !== "archive") : [];
}

async function onGate(frame) {
	if (!metrics.prepAt) {
		metrics.prepAt = nowIso();
		prepStats = await rpc.stats();
		for (const id of changeIds()) copyIfExists(join(paths.ws, "readyset", "changes", id), join(paths.out, "prep", "readyset-change", id));
		copyIfExists(brainstormDir, join(paths.out, "prep", "brainstorms"));
		metrics.prepWorktreeStatus = git(paths.ws, ["status", "--porcelain"]);
		event("review-gate", { title: frame.title });
	} else event("review-gate-again", { title: frame.title });
	rpc.respondUi(frame.id, { value: frame.options.find((o) => o === "Approve & Execute") ?? frame.options[0] });
}

/** Readyset's own pickers. Returns true when handled. */
async function onReadysetUi(frame) {
	if (frame.method !== "select") return false;
	const title = frame.title ?? "";
	const opts = frame.options ?? [];
	if (/^Pick a brainstorm/i.test(title)) {
		const pick = opts.find((o) => !o.startsWith("✎")) ?? opts[0];
		event("picker", { pick });
		rpc.respondUi(frame.id, { value: pick });
		return true;
	}
	if (opts.includes("Continue anyway")) {
		metrics.gateWarnings.push(title);
		event("brainstorm-gap-warning", { title });
		rpc.respondUi(frame.id, { value: "Continue anyway" });
		return true;
	}
	if (/^Review change/i.test(title) && opts.includes("Approve & Execute")) {
		await onGate(frame);
		return true;
	}
	if (opts.includes("Send back for verification") || opts.includes("Continue to code review anyway")) {
		// Take the workflow's own first (default) option, as a user following the tool would.
		const pick = opts[0];
		if (pick === "Send back for verification") metrics.verificationSendbacks++;
		event("verification-prompt", { title, pick });
		rpc.respondUi(frame.id, { value: pick });
		return true;
	}
	if (/Archive now\?/i.test(title) || opts.includes("Archive now")) {
		pipelineDone = true;
		event("archive-prompt");
		rpc.respondUi(frame.id, { value: opts.find((o) => o === "Not yet") ?? opts.at(-1) });
		return true;
	}
	return false;
}

rpc.on("frame", (frame) => {
	if (frame.type !== "extension_ui_request") return;
	if (frame.method === "notify") {
		event("notify", { message: String(frame.message ?? "").slice(0, 500), level: frame.notifyType });
		return;
	}
	if (!["select", "confirm", "input", "editor"].includes(frame.method)) return;
	metrics.uiRequests++;
	busy++;
	(async () => {
		if (await onReadysetUi(frame)) return;
		if (metrics.phase === "pipeline" && frame.method === "select" && !/\?|\(|question/i.test(frame.title ?? "")) {
			metrics.unexpectedUi.push({ title: frame.title, options: frame.options });
		}
		await answerAgentUi(rpc, frame, simUser, uiState);
	})()
		.catch((e) => {
			metrics.errors.push(`ui: ${e.message}`);
			rpc.respondUi(frame.id, { cancelled: true });
		})
		.finally(() => busy--);
});
rpc.on("spawn-error", (e) => metrics.errors.push(`spawn: ${e.message}`));

const quote = (text) => `'${text.replace(/'/g, "’")}'`; // readyset's arg parser keeps everything inside single quotes verbatim
const pipelineCommand = () => `/readyset --fast --model ${models.planModel}`;

async function main() {
	await Promise.race([rpc.ready, new Promise((_, rej) => setTimeout(() => rej(new Error("omp did not become ready in 120s")), 120_000))]);
	event("ready");
	rpc.prompt(`/readyset --model ${models.planModel} --idea ${quote(task.request)}`);
	event("grill-started");

	for (;;) {
		const idle = await rpc.waitIdle({ quietMs: cfg.limits.idleSeconds * 1000, deadline, isBusy: () => busy > 0 });
		if (idle !== "idle") {
			metrics.status = idle === "timeout" ? "timeout" : "omp-exited";
			return;
		}

		if (metrics.phase === "grill") {
			if (listMd(brainstormDir).length > 0) {
				metrics.phase = "pipeline";
				metrics.brainstormAt = nowIso();
				event("brainstorm-written", { files: listMd(brainstormDir) });
				rpc.prompt(pipelineCommand());
				continue;
			}
		} else if (pipelineDone) {
			metrics.status = "done";
			return;
		}

		const text = (await rpc.lastAssistantText()) ?? "";
		const canAnswer = simUser.answers < cfg.limits.maxSimUserAnswers;
		const verdict = text && canAnswer ? await simUser.onAgentMessage(text) : { needsReply: false };
		if (verdict.needsReply) {
			event("sim-user-reply", { phase: metrics.phase });
			rpc.prompt(verdict.reply);
			continue;
		}
		if (metrics.nudges >= cfg.limits.maxNudges) {
			// "gate-not-shown": artefacts were written but the review gate never reached us (see
			// readyset 0.11.2's RPC fix) — distinct from Propose genuinely failing to write a proposal.
			const proposed = changeIds().some((id) => existsSync(join(paths.ws, "readyset", "changes", id, "proposal.md")));
			metrics.status = metrics.phase === "grill" ? "no-brainstorm" : metrics.prepAt ? "pipeline-stopped" : proposed ? "gate-not-shown" : "no-proposal";
			return;
		}
		metrics.nudges++;
		if (metrics.phase === "grill") {
			event("nudge", { phase: "grill" });
			rpc.prompt("Please write the brainstorm file now.");
		} else {
			// The command returned early (paused apply, unfinished propose…). A real user re-runs /readyset,
			// which resumes an existing change at the review gate.
			metrics.resumes++;
			event("resume", { phase: "pipeline" });
			rpc.prompt(pipelineCommand());
		}
	}
}

try {
	await main();
} catch (e) {
	metrics.status = "error";
	metrics.errors.push(String(e.stack ?? e));
}

const finalStats = await rpc.stats();
try {
	const messages = await rpc.request({ type: "get_messages" }, 60_000);
	writeFileSync(join(paths.out, "messages.json"), JSON.stringify(messages, null, 1));
} catch (e) {
	metrics.errors.push(`get_messages: ${e.message}`);
}
await rpc.close();

copyIfExists(join(paths.ws, "readyset"), join(paths.out, "final", "readyset"));
copyIfExists(join(paths.ws, ".ai"), join(paths.out, "final", "ai"));
const diff = captureDiff(paths.ws, baseSha);
writeFileSync(join(paths.out, "final", "changes.diff"), diff.full);
writeFileSync(join(paths.out, "final", "numstat.txt"), diff.stat);

metrics.finishedAt = nowIso();
metrics.simUserAnswers = simUser.answers;
metrics.planCaptured = existsSync(join(paths.out, "prep", "readyset-change"));
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
console.log(`readyset[${task.id} ${argv.model} r${argv.rep}] ${metrics.status} — ${Math.round(metrics.wallMs / 1000)}s, sim-user answers ${metrics.simUserAnswers}`);
process.exit(0);
