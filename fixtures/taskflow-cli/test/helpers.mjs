import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.mjs";

/** A throwaway TASKFLOW_HOME plus a helper that runs the CLI in-process and captures output. */
export function sandbox() {
	const home = mkdtempSync(join(tmpdir(), "taskflow-test-"));
	const env = { TASKFLOW_HOME: home };
	return {
		home,
		file: join(home, "tasks.json"),
		async cli(...argv) {
			let stdout = "";
			let stderr = "";
			const io = {
				env,
				stdout: { write: (s) => void (stdout += s) },
				stderr: { write: (s) => void (stderr += s) },
			};
			const code = await run(argv, io);
			return { code, stdout, stderr };
		},
		read() {
			return existsSync(join(home, "tasks.json")) ? JSON.parse(readFileSync(join(home, "tasks.json"), "utf8")) : null;
		},
		write(data) {
			writeFileSync(join(home, "tasks.json"), typeof data === "string" ? data : JSON.stringify(data, null, 2));
		},
		cleanup() {
			rmSync(home, { recursive: true, force: true });
		},
	};
}
