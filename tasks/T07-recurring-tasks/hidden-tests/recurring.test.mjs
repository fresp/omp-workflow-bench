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

test("add --every stores the recurrence", async () => {
	await withSandbox(async (s) => {
		const res = await s.cli("add", "Weekly review", "--due", "2026-03-02", "--every", "week");
		assert.equal(res.code, 0);
		assert.equal(s.read().tasks[0].every, "week");
	});
});

test("invalid --every value is rejected", async () => {
	await withSandbox(async (s) => {
		const res = await s.cli("add", "x", "--due", "2026-03-02", "--every", "fortnight");
		assert.equal(res.code, 1);
		assert.match(res.stderr, /^Error: /);
		assert.equal(s.read(), null);
	});
});

test("--every without --due is rejected", async () => {
	await withSandbox(async (s) => {
		const res = await s.cli("add", "x", "--every", "day");
		assert.equal(res.code, 1);
		assert.match(res.stderr, /^Error: /);
		assert.equal(s.read(), null);
	});
});

test("done on a weekly task creates the next occurrence", async () => {
	await withSandbox(async (s) => {
		await s.cli("add", "Weekly review", "--due", "2026-03-02", "--every", "week", "--tags", "work");
		const res = await s.cli("done", "1");
		assert.equal(res.code, 0);
		assert.match(res.stdout, /^Completed #1: Weekly review\n/);
		assert.match(res.stdout, /Next: #2 due 2026-03-09/);
		const [first, next] = s.read().tasks;
		assert.equal(first.done, true);
		assert.deepEqual(
			{ id: next.id, title: next.title, done: next.done, due: next.due, tags: next.tags, every: next.every },
			{ id: 2, title: "Weekly review", done: false, due: "2026-03-09", tags: "work", every: "week" },
		);
	});
});

test("daily recurrence crosses month and year boundaries", async () => {
	await withSandbox(async (s) => {
		await s.cli("add", "Standup", "--due", "2026-12-31", "--every", "day");
		await s.cli("done", "1");
		assert.equal(s.read().tasks[1].due, "2027-01-01");
	});
});

test("the schedule follows the previous due date, not the completion date", async () => {
	await withSandbox(async (s) => {
		await s.cli("add", "Pay rent", "--due", "2020-01-15", "--every", "month"); // long overdue
		await s.cli("done", "1");
		assert.equal(s.read().tasks[1].due, "2020-02-15");
	});
});

test("monthly on the 31st clamps to the end of shorter months, then continues from the clamped date", async () => {
	await withSandbox(async (s) => {
		await s.cli("add", "Invoice", "--due", "2026-01-31", "--every", "month");
		await s.cli("done", "1");
		assert.equal(s.read().tasks[1].due, "2026-02-28");
		await s.cli("done", "2");
		assert.equal(s.read().tasks[2].due, "2026-03-28");
	});
});

test("leap year: 2028-01-31 monthly → 2028-02-29", async () => {
	await withSandbox(async (s) => {
		await s.cli("add", "Invoice", "--due", "2028-01-31", "--every", "month");
		await s.cli("done", "1");
		assert.equal(s.read().tasks[1].due, "2028-02-29");
	});
});

test("completing an already-done recurring task does not create another occurrence", async () => {
	await withSandbox(async (s) => {
		await s.cli("add", "Water plants", "--due", "2026-03-02", "--every", "day");
		await s.cli("done", "1");
		await s.cli("done", "1");
		assert.equal(s.read().tasks.length, 2);
	});
});

test("normal tasks are unaffected by done", async () => {
	await withSandbox(async (s) => {
		await s.cli("add", "One-off", "--due", "2026-03-02");
		const res = await s.cli("done", "1");
		assert.equal(res.stdout, "Completed #1: One-off\n");
		assert.equal(s.read().tasks.length, 1);
	});
});

test("list marks recurring tasks", async () => {
	await withSandbox(async (s) => {
		await s.cli("add", "Weekly review", "--due", "2026-03-02", "--every", "week");
		await s.cli("add", "One-off");
		const out = (await s.cli("list")).stdout;
		assert.match(out, /Weekly review \(every week\)/);
		assert.doesNotMatch(out, /One-off \(every/);
	});
});

test("remove deletes only that occurrence", async () => {
	await withSandbox(async (s) => {
		await s.cli("add", "Weekly review", "--due", "2026-03-02", "--every", "week");
		await s.cli("done", "1");
		assert.equal((await s.cli("remove", "2")).code, 0);
		assert.deepEqual(s.read().tasks.map((t) => t.id), [1]);
	});
});
