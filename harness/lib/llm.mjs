// One-shot LLM calls for the simulated user and the judges.
//   backend "omp":    `omp -p --no-tools …` — reuses whatever auth omp already has, no extra keys
//   backend "openai": any OpenAI-compatible /chat/completions endpoint (bench.config.json → openai)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * @param {{ backend?: string, model: string, prompt: string, timeoutSeconds?: number, cfg: object }} opts
 * @returns {Promise<string>} the model's text reply
 */
export async function complete({ backend = "omp", model, prompt, timeoutSeconds = 300, cfg }) {
	if (process.env.BENCH_FAKE_LLM) return fakeReply(prompt);
	if (backend === "openai") return completeOpenAI({ model, prompt, timeoutSeconds, cfg });
	if (backend === "omp") return completeOmp({ model, prompt, timeoutSeconds, cfg });
	throw new Error(`unknown llm backend: ${backend}`);
}

async function completeOmp({ model, prompt, timeoutSeconds, cfg }) {
	const dir = mkdtempSync(join(tmpdir(), "rsb-llm-"));
	const file = join(dir, "instructions.md");
	writeFileSync(file, prompt);
	const args = [
		"-p",
		"--no-tools",
		"--no-extensions",
		"--no-skills",
		"--no-rules",
		"--no-session",
		"--model",
		model,
		`@${file}`,
		"Follow the instructions in the attached file exactly. Output only what they ask for.",
	];
	try {
		return await new Promise((resolve, reject) => {
			const child = spawn(cfg?.omp?.bin ?? "omp", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
			let out = "";
			let err = "";
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				reject(new Error(`omp -p timed out after ${timeoutSeconds}s (model ${model})`));
			}, timeoutSeconds * 1000);
			child.stdout.on("data", (d) => (out += d));
			child.stderr.on("data", (d) => (err += d));
			child.on("error", (e) => {
				clearTimeout(timer);
				reject(e);
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				if (code !== 0 && out.trim() === "") reject(new Error(`omp -p exited ${code}: ${err.slice(-1500)}`));
				else resolve(out.trim());
			});
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function completeOpenAI({ model, prompt, timeoutSeconds, cfg }) {
	const base = cfg?.openai?.baseUrl;
	const key = process.env[cfg?.openai?.apiKeyEnv ?? "BENCH_OPENAI_API_KEY"];
	if (!base || !key) throw new Error("openai backend needs openai.baseUrl in bench.config.json and the API key env var set");
	const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
		body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
		signal: AbortSignal.timeout(timeoutSeconds * 1000),
	});
	if (!res.ok) throw new Error(`openai backend ${res.status}: ${(await res.text()).slice(0, 1000)}`);
	const body = await res.json();
	return String(body.choices?.[0]?.message?.content ?? "").trim();
}

/** Pull the first JSON object out of a model reply (tolerates ```json fences and prose around it). */
export function extractJson(text) {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
	const candidates = [fenced?.[1], text];
	for (const c of candidates) {
		if (!c) continue;
		const start = c.indexOf("{");
		if (start === -1) continue;
		let depth = 0;
		let inStr = false;
		for (let i = start; i < c.length; i++) {
			const ch = c[i];
			if (inStr) {
				if (ch === "\\") i++;
				else if (ch === '"') inStr = false;
				continue;
			}
			if (ch === '"') inStr = true;
			else if (ch === "{") depth++;
			else if (ch === "}" && --depth === 0) {
				try {
					return JSON.parse(c.slice(start, i + 1));
				} catch {
					break;
				}
			}
		}
	}
	throw new Error(`no JSON object in reply: ${text.slice(0, 300)}`);
}

/** complete() + extractJson() with a couple of retries on malformed output. */
export async function completeJson(opts, { retries = 2 } = {}) {
	let lastErr;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const text = await complete(opts);
			return { json: extractJson(text), raw: text };
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr;
}

/** Canned replies for the offline smoke test only (BENCH_FAKE_LLM=1). */
function fakeReply(prompt) {
	if (prompt.includes('"needs_reply"')) {
		const msg = /<assistant_message>([\s\S]*?)<\/assistant_message>/.exec(prompt)?.[1] ?? "";
		return JSON.stringify(/\?/.test(msg) ? { needs_reply: true, reply: "Per API key, 60 per minute, proceed." } : { needs_reply: false, reply: "" });
	}
	if (prompt.includes('"choice"')) {
		const first = /^1\. (.*)$/m.exec(prompt)?.[1] ?? null;
		return JSON.stringify({ choice: first, text: "" });
	}
	if (prompt.includes('"reply"')) return JSON.stringify({ reply: "No preference." });
	if (prompt.includes("BENCH_JUDGE")) {
		return JSON.stringify({
			dimensions: Object.fromEntries((/DIMENSIONS: (.*)/.exec(prompt)?.[1] ?? "overall").split(",").map((d) => [d.trim(), "B"])),
			overall: "B",
			confidence: "medium",
			rationale: "fake judge",
		});
	}
	return "{}";
}
