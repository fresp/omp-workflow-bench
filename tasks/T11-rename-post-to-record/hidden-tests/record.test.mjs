import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { importCsv } from "../../src/index.mjs";
import { household } from "../fixtures.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("record() posts an entry and updates balances", () => {
	const l = household();
	const e = l.record({ date: "2026-01-25T09:00:00+07:00", description: "Salary", from: "salary", to: "bank", amount: 500 });
	assert.equal(e.amount, 500);
	assert.ok(Object.isFrozen(e));
	assert.equal(l.balance("bank"), 500);
	assert.throws(() => l.record({ date: "x", from: "bank", to: "food", amount: 1 }), /invalid date/);
});

test("post() still works, returns the entry, and warns exactly once per process", async () => {
	const warnings = [];
	const onWarning = (w) => warnings.push(w);
	process.on("warning", onWarning);
	try {
		const l = household();
		const a = l.post({ date: "2026-01-25T09:00:00Z", from: "salary", to: "bank", amount: 1 });
		const b = l.post({ date: "2026-01-26T09:00:00Z", from: "salary", to: "bank", amount: 2 });
		new (l.constructor)().addAccount({ id: "x", type: "asset" });
		l.post({ date: "2026-01-27T09:00:00Z", from: "salary", to: "bank", amount: 3 });
		assert.equal(a.amount, 1);
		assert.equal(b.id, 2);
		assert.equal(l.balance("bank"), 6);
		assert.throws(() => l.post({ date: "2026-01-27T09:00:00Z", from: "salary", to: "nope", amount: 3 }), /unknown account/);
		await new Promise((r) => setImmediate(r));
		const ours = warnings.filter((w) => w.code === "LEDGER_DEP_POST");
		assert.equal(ours.length, 1);
		assert.equal(ours[0].name, "DeprecationWarning");
		assert.match(ours[0].message, /record\(/);
	} finally {
		process.off("warning", onWarning);
	}
});

test("importCsv uses record(), not the deprecated alias", () => {
	const l = household();
	let postCalls = 0;
	l.post = () => {
		postCalls++;
		throw new Error("post() must not be used internally");
	};
	importCsv(l, "date,description,from,to,amount\n2026-01-25T09:00:00Z,Salary,salary,bank,5.00\n");
	assert.equal(postCalls, 0);
	assert.equal(l.balance("bank"), 500);
});

function walk(dir) {
	return readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		return statSync(p).isDirectory() ? walk(p) : [p];
	});
}

test("no internal call sites of .post( remain in src/ and examples/", () => {
	for (const file of [...walk(join(ROOT, "src")), ...walk(join(ROOT, "examples"))]) {
		const src = readFileSync(file, "utf8");
		// a call passes an argument: `.post({` / `.post(x`; mentions like "post()" in messages or docs are fine
		const calls = src
			.split("\n")
			.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
			.filter((line) => /\.post\(\s*[^)\s]/.test(line));
		assert.deepEqual(calls, [], file);
	}
});

test("README documents record() and the deprecation", () => {
	const readme = readFileSync(join(ROOT, "README.md"), "utf8");
	assert.match(readme, /record\(/);
	assert.match(readme, /deprecat/i);
	const usage = readme.split("\n").filter((line) => /ledger\.post\(/.test(line));
	assert.deepEqual(usage, [], "README examples still use ledger.post(");
});

test("CHANGELOG has an Unreleased entry and the version is unchanged", () => {
	assert.ok(existsSync(join(ROOT, "CHANGELOG.md")));
	const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
	assert.match(changelog, /Unreleased/i);
	assert.match(changelog, /record/);
	assert.equal(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version, "2.1.0");
});
