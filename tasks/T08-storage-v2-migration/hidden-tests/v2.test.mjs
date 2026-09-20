import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "../helpers.mjs";

async function withSandbox(fn) {
	const s = sandbox();
	try {
		await fn(s);
	} finally {
		s.cleanup();
	}
}

const V1 = JSON.stringify(
	{
		nextId: 4,
		tasks: [
			{ id: 1, title: "Write report", done: false, due: "2026-03-01", tags: "work, writing", createdAt: "2026-01-01T00:00:00.000Z" },
			{ id: 2, title: "Groceries", done: true, due: null, tags: "", createdAt: "2026-01-02T00:00:00.000Z", note: "keep me" },
			{ id: 3, title: "Odd tags", done: false, due: null, tags: " a, ,b ", createdAt: "2026-01-03T00:00:00.000Z" },
		],
	},
	null,
	2,
);

test("new files are written as v2 with tag arrays", async () => {
	await withSandbox(async (s) => {
		await s.cli("add", "A", "--tags", "x, y");
		const data = s.read();
		assert.equal(data.schemaVersion, 2);
		assert.deepEqual(data.tasks[0].tags, ["x", "y"]);
		assert.equal(existsSync(join(s.home, "tasks.v1.bak.json")), false);
	});
});

test("a v1 file is migrated on list, written back, with a byte-exact backup", async () => {
	await withSandbox(async (s) => {
		s.write(V1);
		const res = await s.cli("list", "--all");
		assert.equal(res.code, 0);
		assert.equal(readFileSync(join(s.home, "tasks.v1.bak.json"), "utf8"), V1);
		const data = s.read();
		assert.equal(data.schemaVersion, 2);
		assert.equal(data.nextId, 4);
		assert.deepEqual(data.tasks.map((t) => t.tags), [["work", "writing"], [], ["a", "b"]]);
		assert.equal(data.tasks[1].note, "keep me");
		assert.equal(data.tasks[0].due, "2026-03-01");
		assert.equal(readFileSync(s.file, "utf8"), JSON.stringify(data, null, 2));
	});
});

test("list output is unchanged after migration", async () => {
	await withSandbox(async (s) => {
		s.write(V1);
		const out = (await s.cli("list", "--all")).stdout;
		assert.equal(
			out,
			"ID  DONE  TITLE         DUE         TAGS\n" +
				"1         Write report  2026-03-01  work,writing\n" +
				"2   x     Groceries\n" +
				"3         Odd tags                  a,b\n",
		);
		assert.match((await s.cli("list", "--tag", "writing")).stdout, /Write report/);
	});
});

test("missing tags field becomes []", async () => {
	await withSandbox(async (s) => {
		s.write({ nextId: 2, tasks: [{ id: 1, title: "no tags", done: false, due: null, createdAt: "2026-01-01T00:00:00.000Z" }] });
		await s.cli("list");
		assert.deepEqual(s.read().tasks[0].tags, []);
	});
});

test("migration also happens on write commands", async () => {
	await withSandbox(async (s) => {
		s.write(V1);
		await s.cli("add", "New", "--tags", "z");
		const data = s.read();
		assert.equal(data.schemaVersion, 2);
		assert.deepEqual(data.tasks.at(-1).tags, ["z"]);
		assert.deepEqual(data.tasks[0].tags, ["work", "writing"]);
		assert.ok(existsSync(join(s.home, "tasks.v1.bak.json")));
	});
});

test("an existing backup is never overwritten", async () => {
	await withSandbox(async (s) => {
		writeFileSync(join(s.home, "tasks.v1.bak.json"), "OLDEST");
		s.write(V1);
		await s.cli("list");
		assert.equal(readFileSync(join(s.home, "tasks.v1.bak.json"), "utf8"), "OLDEST");
		assert.equal(s.read().schemaVersion, 2);
	});
});

test("a v2 file is not migrated again", async () => {
	await withSandbox(async (s) => {
		await s.cli("add", "A", "--tags", "x");
		await s.cli("list");
		assert.equal(existsSync(join(s.home, "tasks.v1.bak.json")), false);
		assert.deepEqual(s.read().tasks[0].tags, ["x"]);
	});
});

test("a file from a newer version is refused and left untouched", async () => {
	await withSandbox(async (s) => {
		const future = JSON.stringify({ schemaVersion: 3, nextId: 1, tasks: [] }, null, 2);
		s.write(future);
		for (const argv of [["list"], ["add", "x"]]) {
			const res = await s.cli(...argv);
			assert.equal(res.code, 1, argv.join(" "));
			assert.match(res.stderr, /^Error: .*newer/i);
		}
		assert.equal(readFileSync(s.file, "utf8"), future);
		assert.equal(existsSync(join(s.home, "tasks.v1.bak.json")), false);
	});
});
