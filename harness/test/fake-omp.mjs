#!/usr/bin/env node
// Offline stand-in for `omp --mode rpc`, just rich enough to drive both arm scripts end to end.
// Emulates: ready frame, prompts, get_state / get_session_stats / get_last_assistant_text /
// get_messages, ask-tool selects (plan arm), readyset's pickers and review gate (readyset arm).
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const cwd = opt("--cwd");
const isPlan = argv.includes("--plan-yolo");
const overlay = opt("--config");
const autosaveDir = overlay ? JSON.parse(/autosaveDir: (.*)/.exec(readFileSync(overlay, "utf8"))[1]) : null;

let streaming = false;
let lastText = null;
let uiSeq = 0;
const waiting = new Map();
const out = (f) => process.stdout.write(`${JSON.stringify(f)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

async function turn(text, fn) {
	streaming = true;
	out({ type: "agent_start" });
	for (let i = 0; i < 3; i++) {
		out({ type: "message_update", delta: "…" });
		await sleep(50);
	}
	tokens.input += 1000;
	tokens.output += 200;
	tokens.total += 1200;
	if (fn) await fn();
	lastText = text;
	out({ type: "agent_end" });
	streaming = false;
}

function ui(method, title, options) {
	const id = `ui${++uiSeq}`;
	out({ type: "extension_ui_request", id, method, title, options });
	return new Promise((resolve) => waiting.set(id, resolve));
}

let readysetStage = "start";
async function onPrompt(message) {
	if (isPlan) {
		await turn("", async () => {
			const answer = await ui("select", "How should clients be identified?", ["Per API key", "Per IP", "Other (type your own)"]);
			appendFileSync(join(cwd, ".fake-answers"), `${answer.value}\n`);
			mkdirSync(autosaveDir, { recursive: true });
			writeFileSync(join(autosaveDir, "rate-limit-plan.md"), "# Plan\n\n1. Add middleware in src/app.mjs\n2. Use src/lib/clock.mjs\n");
			out({ type: "notice", level: "info", message: "Plan-yolo: plan approved, switched to x to implement." });
			writeFileSync(join(cwd, "src", "lib", "rate-limit.mjs"), "export const x = 1;\n");
		});
		lastText = "Implemented rate limiting.";
		return;
	}
	if (message.startsWith("/readyset") && message.includes("--idea")) {
		await turn("Pertanyaan: dibatasi per API key atau per IP?");
		readysetStage = "grilling";
		return;
	}
	if (readysetStage === "grilling" && !message.startsWith("/readyset")) {
		await turn("Brainstorm written to .ai/brainstorms/2026-01-01-rate-limiting.md — run /readyset.", async () => {
			mkdirSync(join(cwd, ".ai", "brainstorms"), { recursive: true });
			writeFileSync(join(cwd, ".ai", "brainstorms", "2026-01-01-rate-limiting.md"), "---\ntitle: Rate limiting\nlane: full\n---\n## Decision\nper key\n");
		});
		readysetStage = "brainstormed";
		return;
	}
	if (/^\/readyset( --lane (fast|full|auto))? --model/.test(message) || message.startsWith("/readyset --fast")) {
		(async () => {
			streaming = true;
			const pick = await ui("select", "Pick a brainstorm to take through Readyset (fused review)", ["✎ Type a new idea (grill it here)", "2026-01-01 · Rate limiting"]);
			if (!pick.value?.includes("Rate limiting")) throw new Error("bad pick");
			await turn("Explored.", async () => {
				const d = join(cwd, "readyset", "changes", "rate-limiting");
				mkdirSync(join(d, "specs", "api"), { recursive: true });
				writeFileSync(join(d, "EXPLORATION.md"), "found src/app.mjs\n");
			});
			await turn("Proposed.", async () => {
				const d = join(cwd, "readyset", "changes", "rate-limiting");
				writeFileSync(join(d, "proposal.md"), "# Proposal\nRate limit per key.\n");
				writeFileSync(join(d, "design.md"), "# Design\nMiddleware in `src/app.mjs`, see readyset/changes/rate-limiting.\n");
				writeFileSync(join(d, "tasks.md"), "- [ ] 1. Add middleware\n  _Verified:_ \n");
				writeFileSync(join(d, "specs", "api", "spec.md"), "## ADDED Requirements\n### Requirement: limit\n");
				// CONTEXT.md with the readyset ≥ 0.13 phase markers, so compile.mjs emits the lane,
				// phase, outcome, review and mechanism fields without any real model calls.
				const at = (s) => new Date(Date.now() + s * 1000).toISOString();
				const marker = (ev) => `<!-- readyset-phase -->\n\`\`\`json\n${JSON.stringify(ev)}\n\`\`\`\n`;
				writeFileSync(
					join(d, "CONTEXT.md"),
					[
						"# Change: rate-limiting",
						marker({ phase: "gate", edge: "start", at: at(0), lane: "full", laneSource: "brainstorm" }),
						marker({ phase: "gate", edge: "end", at: at(1), outcome: "approved", outsideRepo: 0, outsideRepoTmp: 0 }),
						marker({ phase: "apply", edge: "start", at: at(1) }),
						marker({ phase: "apply", edge: "end", at: at(4), outcome: "done", diff: { files: 1, added: 2, deleted: 0 } }),
						marker({ phase: "contract-repair", edge: "end", at: at(5), outcome: "resolved" }),
						marker({ phase: "review", edge: "start", at: at(6), triggersEvaluated: ["diff-size", "risk"], triggersFired: ["diff-size"] }),
						marker({ phase: "review", edge: "end", at: at(8), outcome: "fixed" }),
						marker({ phase: "scope-reconcile", edge: "end", at: at(9), outcome: "reverted" }),
					].join("\n"),
				);
			});
			streaming = true;
			const gate = await ui("select", 'Review change "rate-limiting" — structurally valid', ["Approve & Execute", "Approve & Compact", "Refine", "Discard"]);
			if (gate.value !== "Approve & Execute") throw new Error("gate not approved");
			await turn("Implemented.", async () => writeFileSync(join(cwd, "src", "lib", "rate-limit.mjs"), "export const y = 2;\n"));
			streaming = true;
			await ui("select", "Implementation complete, but 1/1 checked tasks have no _Verified: note", ["Send back for verification", "Continue to code review anyway"]);
			await turn("Verified.");
			await turn("Reviewed.", async () => writeFileSync(join(cwd, "readyset", "changes", "rate-limiting", "REVIEW.md"), "LGTM\n"));
			streaming = true;
			await ui("select", 'Code review done for "rate-limiting". Archive now?', ["Archive now", "Address findings first", "Not yet"]);
			streaming = false;
		})();
		return;
	}
	await turn("ok");
}

out({ type: "ready", protocolVersion: 1 });
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
	const cmd = JSON.parse(line);
	if (cmd.type === "extension_ui_response") {
		waiting.get(cmd.id)?.(cmd);
		waiting.delete(cmd.id);
		return;
	}
	const reply = (data) => out({ type: "response", id: cmd.id, command: cmd.type, success: true, data });
	switch (cmd.type) {
		case "prompt":
			reply(undefined);
			void onPrompt(cmd.message);
			break;
		case "get_state":
			reply({ isStreaming: streaming || waiting.size > 0, isCompacting: false, queuedMessageCount: 0 });
			break;
		case "get_session_stats":
			reply({ tokens: { ...tokens }, cost: 0, toolCalls: 3, assistantMessages: 2, userMessages: 1, routedModels: { "fake/model": 2 } });
			break;
		case "get_last_assistant_text":
			reply({ text: lastText });
			break;
		case "get_messages":
			reply({ messages: [] });
			break;
		default:
			reply(null);
	}
});
