// Simulated user: answers the agent's questions from the task persona only. Every call is logged so
// the transcript of "what the user was asked and what they said" is part of the run's evidence.
import { readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./config.mjs";
import { completeJson } from "./llm.mjs";

const TEMPLATE = readFileSync(join(ROOT, "rubric/sim-user.md"), "utf8");

export function createSimUser({ task, cfg, logFile }) {
	const base = TEMPLATE.replace("{{REQUEST}}", () => task.request).replace("{{PERSONA}}", () => task.persona);
	let answers = 0;
	const log = (entry) => appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);

	async function ask(taskText) {
		const prompt = base.replace("{{TASK}}", () => taskText);
		const { json } = await completeJson({
			backend: cfg.simUser.backend,
			model: cfg.simUser.model,
			prompt,
			timeoutSeconds: cfg.simUser.timeoutSeconds ?? 180,
			cfg,
		});
		return json;
	}

	return {
		get answers() {
			return answers;
		},

		/**
		 * The agent stopped and left a message. Is it waiting on the user? If so, reply as the user.
		 * @returns {Promise<{ needsReply: boolean, reply?: string }>}
		 */
		async onAgentMessage(text) {
			let result;
			try {
				const json = await ask(
					`## Now\n\nThe assistant stopped working and its last message to you is below.\n\n<assistant_message>\n${text}\n</assistant_message>\n\n` +
						"Decide whether this message asks YOU something or waits for your input (a question, a choice, a request to confirm/approve/proceed). " +
						"A pure status report or a summary of finished work does not need a reply.\n\n" +
						'Output ONLY JSON: {"needs_reply": true|false, "reply": "<your reply as the user, or empty>"}',
				);
				result = { needsReply: Boolean(json.needs_reply), reply: String(json.reply ?? "").trim() };
			} catch (err) {
				result = { needsReply: /\?\s*$/m.test(text), reply: "No strong preference — please pick what fits the codebase and continue.", error: String(err.message ?? err) };
			}
			if (result.needsReply) {
				if (!result.reply) result.reply = "No strong preference — please pick what fits the codebase and continue.";
				answers++;
			}
			log({ kind: "message", agent: text, ...result });
			return result;
		},

		/**
		 * A structured picker (omp's ask tool → RPC select).
		 * @returns {Promise<{ choice: string | null, text: string }>} choice = exact option, or null for a free-text answer
		 */
		async onSelect(title, options) {
			let result;
			try {
				const json = await ask(
					`## Now\n\nThe assistant is asking you to pick an option.\n\nQuestion: ${title}\n\nOptions (exact labels):\n${options.map((o, i) => `${i + 1}. ${o}`).join("\n")}\n\n` +
						"Pick exactly one option label. If none fits your facts, set choice to null and give your own short answer in text.\n\n" +
						'Output ONLY JSON: {"choice": "<exact option label or null>", "text": "<short free-text answer, used when choice is null>"}',
				);
				result = { choice: json.choice ?? null, text: String(json.text ?? "").trim() };
			} catch (err) {
				result = { choice: options[0] ?? null, text: "", error: String(err.message ?? err) };
			}
			answers++;
			log({ kind: "select", title, options, ...result });
			return result;
		},

		/** Free-text prompt (omp's ask tool "Other" editor, or an extension input). */
		async onInput(title, pendingText) {
			if (pendingText) {
				log({ kind: "input", title, reply: pendingText, reused: true });
				return pendingText;
			}
			let reply;
			try {
				const json = await ask(
					`## Now\n\nThe assistant asks you to type an answer.\n\nPrompt: ${title}\n\nOutput ONLY JSON: {"reply": "<your short answer>"}`,
				);
				reply = String(json.reply ?? "").trim();
			} catch (err) {
				reply = "No strong preference — pick what fits the codebase.";
			}
			answers++;
			log({ kind: "input", title, reply });
			return reply || "No strong preference — pick what fits the codebase.";
		},
	};
}
