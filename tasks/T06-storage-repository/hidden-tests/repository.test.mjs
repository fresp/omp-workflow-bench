import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandbox } from "../helpers.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const { createTaskRepository } = await import(join(ROOT, "src/storage/task-repository.mjs"));

test("load() on a missing file returns an empty store and does not create it", () => {
	const home = join(mkdtempSync(join(tmpdir(), "tf-repo-")), "nested");
	try {
		const repo = createTaskRepository({ TASKFLOW_HOME: home });
		assert.deepEqual(repo.load(), { nextId: 1, tasks: [] });
		assert.equal(existsSync(join(home, "tasks.json")), false);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("save() creates the directory, round-trips, keeps 2-space JSON and leaves no temp files", () => {
	const home = join(mkdtempSync(join(tmpdir(), "tf-repo-")), "a", "b");
	try {
		const repo = createTaskRepository({ TASKFLOW_HOME: home });
		const data = { nextId: 2, tasks: [{ id: 1, title: "x", done: false, due: null, tags: "", createdAt: "2026-01-01T00:00:00.000Z" }] };
		repo.save(data);
		assert.deepEqual(repo.load(), data);
		assert.equal(readFileSync(join(home, "tasks.json"), "utf8"), JSON.stringify(data, null, 2));
		repo.save({ ...data, nextId: 3 });
		assert.deepEqual(readdirSync(home), ["tasks.json"]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("save() writes via a temp file + rename (never writes tasks.json in place)", async () => {
	const fs = await import("node:fs");
	const home = mkdtempSync(join(tmpdir(), "tf-repo-"));
	const target = join(home, "tasks.json");
	writeFileSync(target, JSON.stringify({ nextId: 1, tasks: [] }, null, 2));
	const repo = createTaskRepository({ TASKFLOW_HOME: home });
	const { syncBuiltinESMExports } = await import("node:module");
	const originals = { writeFileSync: fs.writeFileSync, renameSync: fs.renameSync };
	const writes = [];
	const renames = [];
	fs.default.writeFileSync = (p, ...rest) => {
		writes.push(String(p));
		return originals.writeFileSync(p, ...rest);
	};
	fs.default.renameSync = (a, b) => {
		renames.push([String(a), String(b)]);
		return originals.renameSync(a, b);
	};
	syncBuiltinESMExports();
	try {
		repo.save({ nextId: 5, tasks: [] });
	} finally {
		fs.default.writeFileSync = originals.writeFileSync;
		fs.default.renameSync = originals.renameSync;
		syncBuiltinESMExports();
	}
	try {
		const usedPromisesOrStreams = writes.length === 0 && renames.length === 0;
		if (!usedPromisesOrStreams) {
			assert.ok(!writes.includes(target), "tasks.json must not be written in place");
			assert.ok(renames.some(([, to]) => to === target), "tasks.json must be produced by a rename");
			assert.ok(renames.every(([from]) => from.startsWith(home)), "temp file must live in the same directory");
		}
		assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { nextId: 5, tasks: [] });
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("no command imports node:fs directly", () => {
	for (const file of readdirSync(join(ROOT, "src/commands"))) {
		const src = readFileSync(join(ROOT, "src/commands", file), "utf8");
		assert.doesNotMatch(src, /from\s+["'](node:)?fs(\/promises)?["']|require\(["'](node:)?fs/, `${file} imports fs`);
	}
});

test("CLI behaviour is unchanged end to end", async () => {
	const s = sandbox();
	try {
		assert.equal((await s.cli("add", "A", "--due", "2026-03-01", "--tags", "x,y")).stdout, "Added #1: A\n");
		assert.equal((await s.cli("add", "B")).stdout, "Added #2: B\n");
		assert.equal((await s.cli("done", "1")).stdout, "Completed #1: A\n");
		assert.equal((await s.cli("remove", "2")).stdout, "Removed #2: B\n");
		const all = (await s.cli("list", "--all")).stdout;
		assert.equal(all, "ID  DONE  TITLE  DUE         TAGS\n1   x     A      2026-03-01  x,y\n");
		assert.equal((await s.cli("done", "7")).stderr, "Error: no task #7\n");
		assert.deepEqual(readdirSync(s.home), ["tasks.json"]);
		assert.equal(s.read().nextId, 3);
	} finally {
		s.cleanup();
	}
});

test("a corrupt tasks.json is a clean error, not a crash", async () => {
	const s = sandbox();
	try {
		s.write("{ not json");
		for (const argv of [["list"], ["add", "A"], ["done", "1"], ["remove", "1"]]) {
			const res = await s.cli(...argv);
			assert.equal(res.code, 1, argv.join(" "));
			assert.match(res.stderr, /^Error: /);
			assert.ok(res.stderr.includes(s.file), `mentions ${s.file}: ${res.stderr}`);
		}
		assert.equal(readFileSync(s.file, "utf8"), "{ not json", "corrupt file left untouched");
	} finally {
		s.cleanup();
	}
});
