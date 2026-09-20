#!/usr/bin/env node
// Proves every task is gradeable before any model touches it:
//   1. hidden tests FAIL on the untouched fixture (the task is not already done)
//   2. hidden tests PASS once the reference solution is overlaid (the tests are satisfiable)
//   3. the fixture's own suite still passes with the reference solution (no hidden contradiction)
// On success it records the reference test count as `hiddenTestCount` in task.json.
// Usage: node scripts/validate-tasks.mjs [T01 T02 ...]
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTestDir } from "../harness/lib/tests.mjs";
import { makeWorkspace } from "../harness/lib/workspace.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const wanted = process.argv.slice(2);
const tasks = readdirSync(join(ROOT, "tasks"))
	.filter((d) => /^T\d+/.test(d))
	.filter((d) => wanted.length === 0 || wanted.some((w) => d.startsWith(w)))
	.sort();

let bad = 0;
const scratch = mkdtempSync(join(tmpdir(), "rsb-validate-"));
for (const id of tasks) {
	const dir = join(ROOT, "tasks", id);
	const meta = JSON.parse(readFileSync(join(dir, "task.json"), "utf8"));
	const ws = join(scratch, id);
	makeWorkspace(join(ROOT, "fixtures", meta.fixture), ws);
	cpSync(join(dir, "hidden-tests"), join(ws, "test", "hidden"), { recursive: true });
	const base = runTestDir(ws, "test/hidden");

	if (existsSync(join(dir, "reference"))) cpSync(join(dir, "reference"), ws, { recursive: true });
	const ref = runTestDir(ws, "test/hidden");
	const visible = runTestDir(ws, "test");

	const ok = base.fail > 0 && ref.fail === 0 && ref.pass > 0 && visible.fail === 0;
	if (!ok) bad++;
	// The grader divides by this, so a suite that fails to even load still scores 0/N rather than 0/1.
	if (ok && meta.hiddenTestCount !== ref.total) {
		meta.hiddenTestCount = ref.total;
		writeFileSync(join(dir, "task.json"), `${JSON.stringify(meta, null, 2)}\n`);
	}
	console.log(
		`${ok ? "OK  " : "FAIL"} ${id.padEnd(28)} base ${base.pass}/${base.total} pass  ref ${ref.pass}/${ref.total} pass  visible ${visible.pass}/${visible.total}`,
	);
	if (!ok) {
		if (ref.fail) console.log(`     ref failures: ${ref.failures.join(" | ")}\n${ref.output.slice(-3000)}`);
		if (visible.fail) console.log(`     visible failures: ${visible.failures.join(" | ")}\n${visible.output.slice(-3000)}`);
		if (base.fail === 0) console.log("     hidden tests already pass on the base fixture — task is a no-op");
	}
}
rmSync(scratch, { recursive: true, force: true });
process.exitCode = bad ? 1 : 0;
