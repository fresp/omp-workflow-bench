import { test } from "node:test";
import assert from "node:assert/strict";
import { sandbox } from "./helpers.mjs";

test("add then list", async () => {
	const s = sandbox();
	try {
		assert.equal((await s.cli("add", "Write", "report", "--due", "2026-03-01", "--tags", "work, writing")).code, 0);
		const out = await s.cli("list");
		assert.match(out.stdout, /Write report/);
		assert.match(out.stdout, /2026-03-01/);
		assert.equal(s.read().tasks[0].tags, "work,writing");
	} finally {
		s.cleanup();
	}
});

test("add rejects bad dates and empty titles", async () => {
	const s = sandbox();
	try {
		const bad = await s.cli("add", "x", "--due", "2026-02-30");
		assert.equal(bad.code, 1);
		assert.match(bad.stderr, /^Error: /);
		assert.equal((await s.cli("add")).code, 1);
	} finally {
		s.cleanup();
	}
});

test("done hides a task from list unless --all", async () => {
	const s = sandbox();
	try {
		await s.cli("add", "A");
		await s.cli("add", "B");
		const d = await s.cli("done", "1");
		assert.equal(d.stdout, "Completed #1: A\n");
		assert.doesNotMatch((await s.cli("list")).stdout, /\bA\b/);
		assert.match((await s.cli("list", "--all")).stdout, /\bA\b/);
	} finally {
		s.cleanup();
	}
});

test("list --tag filters", async () => {
	const s = sandbox();
	try {
		await s.cli("add", "A", "--tags", "home");
		await s.cli("add", "B", "--tags", "work");
		const out = (await s.cli("list", "--tag", "work")).stdout;
		assert.match(out, /\bB\b/);
		assert.doesNotMatch(out, /\bA\b/);
	} finally {
		s.cleanup();
	}
});

test("remove and unknown ids", async () => {
	const s = sandbox();
	try {
		await s.cli("add", "A");
		assert.equal((await s.cli("remove", "1")).code, 0);
		assert.equal((await s.cli("remove", "1")).code, 1);
		assert.equal((await s.cli("done", "9")).code, 1);
		assert.equal((await s.cli("list")).stdout, "No tasks.\n");
	} finally {
		s.cleanup();
	}
});
