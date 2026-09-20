import { test } from "node:test";
import assert from "node:assert/strict";
import { sandbox } from "../helpers.mjs";

async function withSandbox(fn) {
	const s = sandbox();
	try {
		await fn(s);
	} finally {
		s.cleanup();
	}
}

const rows = (stdout) => stdout.trim().split("\n");
const header = (stdout) => rows(stdout)[0].split(/\s{2,}/);
const titles = (stdout) =>
	rows(stdout)
		.slice(1)
		.map((line) => line.split(/\s{2,}/));

test("add stores priority lowercase, default medium", async () => {
	await withSandbox(async (s) => {
		assert.equal((await s.cli("add", "A", "--priority", "HIGH")).code, 0);
		assert.equal((await s.cli("add", "B")).code, 0);
		const tasks = s.read().tasks;
		assert.equal(tasks[0].priority, "high");
		assert.equal(tasks[1].priority, "medium");
	});
});

test("invalid priority is rejected with the exact message", async () => {
	await withSandbox(async (s) => {
		const res = await s.cli("add", "A", "--priority", "urgent");
		assert.equal(res.code, 1);
		assert.equal(res.stderr, 'Error: invalid --priority "urgent" (expected high, medium or low)\n');
		assert.equal(s.read(), null, "nothing written");
	});
});

test("list shows a PRIORITY column right after TITLE", async () => {
	await withSandbox(async (s) => {
		await s.cli("add", "A", "--priority", "low");
		const out = (await s.cli("list")).stdout;
		const cols = header(out);
		assert.equal(cols[cols.indexOf("TITLE") + 1], "PRIORITY");
		assert.match(out, /\bA\s+low\b/);
	});
});

test("list sorts by priority then id", async () => {
	await withSandbox(async (s) => {
		await s.cli("add", "one", "--priority", "low");
		await s.cli("add", "two", "--priority", "high");
		await s.cli("add", "three");
		await s.cli("add", "four", "--priority", "high");
		const out = (await s.cli("list")).stdout;
		const order = rows(out)
			.slice(1)
			.map((line) => line.match(/\b(one|two|three|four)\b/)[1]);
		assert.deepEqual(order, ["two", "four", "three", "one"]);
	});
});

test("list --priority filters and composes with --tag and --all", async () => {
	await withSandbox(async (s) => {
		await s.cli("add", "alpha", "--priority", "high", "--tags", "work");
		await s.cli("add", "beta", "--priority", "high", "--tags", "home");
		await s.cli("add", "gamma", "--priority", "low", "--tags", "work");
		await s.cli("add", "delta", "--priority", "high", "--tags", "work");
		await s.cli("done", "4");
		const high = (await s.cli("list", "--priority", "high")).stdout;
		assert.match(high, /alpha/);
		assert.match(high, /beta/);
		assert.doesNotMatch(high, /gamma|delta/);
		const highWork = (await s.cli("list", "--priority", "high", "--tag", "work")).stdout;
		assert.match(highWork, /alpha/);
		assert.doesNotMatch(highWork, /beta|gamma|delta/);
		const highWorkAll = (await s.cli("list", "--priority", "high", "--tag", "work", "--all")).stdout;
		assert.match(highWorkAll, /alpha/);
		assert.match(highWorkAll, /delta/);
	});
});

test("list --priority with an invalid value is an error", async () => {
	await withSandbox(async (s) => {
		await s.cli("add", "A");
		const res = await s.cli("list", "--priority", "soon");
		assert.equal(res.code, 1);
		assert.equal(res.stderr, 'Error: invalid --priority "soon" (expected high, medium or low)\n');
	});
});

test("legacy tasks without a priority behave as medium", async () => {
	await withSandbox(async (s) => {
		s.write({
			nextId: 3,
			tasks: [
				{ id: 1, title: "legacy", done: false, due: null, tags: "", createdAt: "2025-01-01T00:00:00.000Z" },
				{ id: 2, title: "urgent", done: false, due: null, tags: "", createdAt: "2025-01-01T00:00:00.000Z", priority: "high" },
			],
		});
		const out = (await s.cli("list")).stdout;
		assert.match(out, /legacy\s+medium/);
		assert.ok(out.indexOf("urgent") < out.indexOf("legacy"), "high sorts before legacy(medium)");
		assert.match((await s.cli("list", "--priority", "medium")).stdout, /legacy/);
		await s.cli("add", "new-low", "--priority", "low");
		const after = (await s.cli("list")).stdout;
		assert.ok(after.indexOf("legacy") < after.indexOf("new-low"));
	});
});

test("usage text mentions --priority", async () => {
	await withSandbox(async (s) => {
		assert.match((await s.cli("--help")).stdout + (await s.cli()).stdout, /--priority/);
	});
});
