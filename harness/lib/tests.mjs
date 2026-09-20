// Run node:test suites inside a workspace and summarise the result. Used by validation and grading.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * @param {string} cwd repo root
 * @param {string} dir test directory relative to cwd (e.g. "test" or "test/hidden")
 * @returns {{ ran: boolean, pass: number, fail: number, total: number, failures: string[], timedOut: boolean, output: string }}
 */
export function runTestDir(cwd, dir, { timeoutMs = 180000 } = {}) {
	const abs = join(cwd, dir);
	if (!existsSync(abs)) return empty(`no ${dir}/`);
	const files = readdirSync(abs)
		.filter((f) => f.endsWith(".test.mjs") || f.endsWith(".test.js"))
		.sort()
		.map((f) => join(dir, f));
	if (files.length === 0) return empty(`no test files in ${dir}/`);
	const res = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-timeout=60000", ...files], {
		cwd,
		encoding: "utf8",
		timeout: timeoutMs,
		env: { ...process.env, NODE_OPTIONS: "", FORCE_COLOR: "0" },
		maxBuffer: 64 * 1024 * 1024,
	});
	const output = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
	const num = (name) => {
		const m = new RegExp(`^# ${name} (\\d+)`, "m").exec(res.stdout ?? "");
		return m ? Number(m[1]) : 0;
	};
	const pass = num("pass");
	const fail = num("fail") + num("cancelled");
	const failures = [...(res.stdout ?? "").matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1].trim());
	const timedOut = res.error?.code === "ETIMEDOUT";
	// A suite that failed to load (syntax error, missing export) reports its file as a failed test.
	return { ran: true, pass, fail: timedOut && pass + fail === 0 ? 1 : fail, total: pass + fail, failures, timedOut, output: output.slice(-20000) };
}

function empty(why) {
	return { ran: false, pass: 0, fail: 0, total: 0, failures: [], timedOut: false, output: why };
}
