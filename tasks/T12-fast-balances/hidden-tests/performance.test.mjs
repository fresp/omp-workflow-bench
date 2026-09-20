import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger, balanceSheet, totalsByType } from "../../src/index.mjs";

const ACCOUNTS = 40;
const TYPES = ["asset", "liability", "income", "expense", "equity"];

function bigLedger(n) {
	const l = new Ledger();
	for (let i = 0; i < ACCOUNTS; i++) l.addAccount({ id: `a${i}`, name: `A${i}`, type: TYPES[i % TYPES.length] });
	let seed = 7;
	const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
	for (let i = 0; i < n; i++) {
		const from = Math.floor(rnd() * ACCOUNTS);
		const to = (from + 1 + Math.floor(rnd() * (ACCOUNTS - 1))) % ACCOUNTS;
		l.post({ date: "2026-01-01T00:00:00Z", from: `a${from}`, to: `a${to}`, amount: 1 + Math.floor(rnd() * 10000) });
	}
	return l;
}

/** Baseline: the original O(n) algorithm over the same data. */
function naiveBalance(entries, id) {
	let t = 0;
	for (const e of entries) {
		if (e.to === id) t += e.amount;
		if (e.from === id) t -= e.amount;
	}
	return t;
}

function time(fn) {
	const start = process.hrtime.bigint();
	fn();
	return Number(process.hrtime.bigint() - start) / 1e6;
}

test("balances stay correct with transfers interleaved", () => {
	const l = bigLedger(5000);
	for (let i = 0; i < 200; i++) {
		const id = `a${i % ACCOUNTS}`;
		assert.equal(l.balance(id), naiveBalance(l.entries, id));
		l.post({ date: "2026-02-01T00:00:00Z", from: id, to: `a${(i + 3) % ACCOUNTS}`, amount: 5 });
		assert.equal(l.balance(id), naiveBalance(l.entries, id));
	}
	const sheet = balanceSheet(l);
	for (const row of sheet) assert.equal(row.balance, naiveBalance(l.entries, row.id));
	const totals = totalsByType(l);
	assert.equal(Object.values(totals).reduce((a, b) => a + b, 0), 0, "double entry sums to zero");
});

test("public behaviour unchanged", () => {
	const l = bigLedger(10);
	assert.throws(() => l.balance("nope"), /unknown account/);
	const before = l.entries.length;
	l.entries.push({});
	assert.equal(l.entries.length, before);
	assert.ok(Object.isFrozen(l.entries[0]));
	assert.throws(() => l.post({ date: "2026-01-01T00:00:00Z", from: "a1", to: "a1", amount: 1 }));
	assert.equal(l.entries.length, before, "a rejected post does not change anything");
});

test("balance() is at least 20× faster than the O(n) baseline on a large ledger", () => {
	const l = bigLedger(60000);
	const entries = l.entries;
	const ids = Array.from({ length: ACCOUNTS }, (_, i) => `a${i}`);
	for (const id of ids) l.balance(id); // warm up any index
	const QUERIES = 2000;
	let sink = 0;
	const baseline = time(() => {
		for (let i = 0; i < QUERIES; i++) sink += naiveBalance(entries, ids[i % ACCOUNTS]);
	});
	const actual = time(() => {
		for (let i = 0; i < QUERIES; i++) sink += l.balance(ids[i % ACCOUNTS]);
	});
	assert.ok(sink !== 0.5);
	assert.ok(actual * 20 < baseline, `balance(): ${actual.toFixed(1)} ms vs baseline ${baseline.toFixed(1)} ms`);
});

test("posting stays cheap while balances are read in between", () => {
	const l = bigLedger(60000);
	const entries = l.entries;
	const ROUNDS = 1500;
	let sink = 0;
	const baseline = time(() => {
		for (let i = 0; i < ROUNDS; i++) sink += naiveBalance(entries, `a${i % ACCOUNTS}`);
	});
	const actual = time(() => {
		for (let i = 0; i < ROUNDS; i++) {
			l.post({ date: "2026-02-01T00:00:00Z", from: `a${i % ACCOUNTS}`, to: `a${(i + 1) % ACCOUNTS}`, amount: 3 });
			sink += l.balance(`a${i % ACCOUNTS}`);
		}
	});
	assert.ok(sink !== 0.5);
	assert.ok(actual * 10 < baseline, `post+balance: ${actual.toFixed(1)} ms vs baseline ${baseline.toFixed(1)} ms`);
});
