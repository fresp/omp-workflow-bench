// Thin client for `omp --mode rpc`: JSON lines in, JSON lines out.
// Protocol reference: @oh-my-pi/pi-coding-agent src/modes/rpc/rpc-types.ts
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { EventEmitter } from "node:events";

export class OmpRpc extends EventEmitter {
	/**
	 * @param {{ bin: string, args: string[], cwd: string, rawLog: string, stderrLog: string, env?: object, wrap?: string[] }} opts
	 *   `wrap` is an argv prefix (e.g. bwrap flags) placed before the binary; the binary and its
	 *   args are appended to it, so the agent runs confined with its own CLI arguments intact.
	 */
	constructor({ bin, args, cwd, rawLog, stderrLog, env, wrap = [] }) {
		super();
		this.args = args;
		const spawnBin = wrap[0] ?? bin;
		const spawnArgs = [...wrap.slice(1), bin, ...args];
		this.child = spawn(spawnBin, spawnArgs, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
		this.raw = createWriteStream(rawLog, { flags: "a" });
		this.err = createWriteStream(stderrLog, { flags: "a" });
		this.lastFrameAt = Date.now();
		this.pendingUi = new Map();
		this.exited = false;
		this.exitCode = null;
		this.#seq = 0;
		this.#waiters = new Map();
		this.#chunks = new Map();
		let buf = "";
		this.child.stdout.on("data", (d) => {
			buf += d.toString("utf8");
			let nl;
			while ((nl = buf.indexOf("\n")) !== -1) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (line) this.#onLine(line);
			}
		});
		this.child.stderr.on("data", (d) => this.err.write(d));
		this.child.on("exit", (code, signal) => {
			this.exited = true;
			this.exitCode = code ?? signal;
			for (const { reject } of this.#waiters.values()) reject(new Error(`omp exited (${this.exitCode})`));
			this.#waiters.clear();
			this.emit("exit", this.exitCode);
		});
		this.child.on("error", (e) => this.emit("spawn-error", e));
		this.ready = new Promise((resolve) => this.once("ready", resolve));
	}

	#seq;
	#waiters;
	#chunks;

	#onLine(line) {
		let frame;
		try {
			frame = JSON.parse(line);
		} catch {
			this.raw.write(`${JSON.stringify({ type: "unparsed", line: line.slice(0, 2000) })}\n`);
			return;
		}
		if (frame.type === "rpc_chunk") {
			// Large frames arrive split; reassemble before handling.
			const entry = this.#chunks.get(frame.chunkId) ?? { parts: [], got: 0 };
			entry.parts[frame.index] = frame.data;
			entry.got++;
			this.#chunks.set(frame.chunkId, entry);
			if (entry.got === frame.count) {
				this.#chunks.delete(frame.chunkId);
				const joined = entry.parts.join("");
				let text = joined;
				try {
					text = Buffer.from(joined, "base64").toString("utf8");
					JSON.parse(text);
				} catch {
					text = joined;
				}
				this.#onLine(text);
			}
			return;
		}
		// Streaming deltas are huge and useless for the log; keep everything else.
		if (frame.type !== "message_update") this.raw.write(`${line}\n`);
		if (frame.type === "ready") this.emit("ready", frame);
		if (frame.type === "response" && frame.id && this.#waiters.has(frame.id)) {
			const w = this.#waiters.get(frame.id);
			this.#waiters.delete(frame.id);
			if (frame.success === false) w.reject(new Error(`${frame.command}: ${frame.error}`));
			else w.resolve(frame.data);
			return; // our own request/response traffic is not agent activity
		}
		this.lastFrameAt = Date.now();
		if (frame.type === "extension_ui_request") {
			if (frame.method === "cancel") {
				this.pendingUi.delete(frame.targetId);
				return;
			}
			if (["select", "confirm", "input", "editor"].includes(frame.method)) this.pendingUi.set(frame.id, frame);
		}
		this.emit("frame", frame);
	}

	send(payload) {
		if (this.exited) return;
		this.child.stdin.write(`${JSON.stringify(payload)}\n`);
		this.raw.write(`${JSON.stringify({ type: "__sent", payload })}\n`);
	}

	/** Send a command and await its `response` frame. */
	request(payload, timeoutMs = 60000) {
		const id = `h${++this.#seq}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#waiters.delete(id);
				reject(new Error(`${payload.type} timed out`));
			}, timeoutMs);
			this.#waiters.set(id, {
				resolve: (v) => {
					clearTimeout(timer);
					resolve(v);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
			this.send({ ...payload, id });
		});
	}

	respondUi(id, response) {
		this.pendingUi.delete(id);
		this.send({ type: "extension_ui_response", id, ...response });
	}

	prompt(message) {
		this.send({ id: `p${++this.#seq}`, type: "prompt", message });
		this.lastFrameAt = Date.now();
	}

	async state() {
		return this.request({ type: "get_state" }, 30000);
	}

	async stats() {
		try {
			return await this.request({ type: "get_session_stats" }, 30000);
		} catch {
			return null;
		}
	}

	async lastAssistantText() {
		try {
			return (await this.request({ type: "get_last_assistant_text" }, 30000))?.text ?? null;
		} catch {
			return null;
		}
	}

	/**
	 * Resolve once the agent is idle: no frames for `quietMs`, nothing streaming or queued, and no
	 * unanswered UI request. Extension commands (/readyset) fire several turns back to back, so a
	 * short quiet gap alone is not trusted — get_state must agree.
	 */
	async waitIdle({ quietMs, deadline, isBusy = () => false }) {
		for (;;) {
			if (this.exited) return "exited";
			if (Date.now() > deadline) return "timeout";
			await sleep(1000);
			if (this.pendingUi.size > 0 || isBusy()) continue;
			if (Date.now() - this.lastFrameAt < quietMs) continue;
			let st;
			try {
				st = await this.state();
			} catch {
				continue;
			}
			if (!st.isStreaming && !st.isCompacting && !(st.queuedMessageCount > 0) && this.pendingUi.size === 0 && Date.now() - this.lastFrameAt >= quietMs - 1500) {
				return "idle";
			}
		}
	}

	async close() {
		if (this.exited) return;
		try {
			this.child.stdin.end();
		} catch {}
		this.child.kill("SIGTERM");
		await Promise.race([new Promise((r) => this.once("exit", r)), sleep(5000)]);
		if (!this.exited) this.child.kill("SIGKILL");
		await new Promise((r) => this.raw.end(r));
		await new Promise((r) => this.err.end(r));
	}
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
