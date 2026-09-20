import { test } from "node:test";
import assert from "node:assert/strict";
import { household } from "./fixtures.mjs";

test("post + balance", () => {
	const l = household();
	l.record({ date: "2026-01-25T09:00:00+07:00", description: "Salary", from: "salary", to: "bank", amount: 500000 });
	l.record({ date: "2026-01-26T10:00:00+07:00", description: "Food", from: "bank", to: "food", amount: 12500 });
	assert.equal(l.balance("bank"), 487500);
	assert.equal(l.balance("salary"), -500000);
	assert.equal(l.balance("food"), 12500);
	assert.equal(l.entries.length, 2);
});

test("post validates", () => {
	const l = household();
	assert.throws(() => l.record({ date: "nope", from: "bank", to: "food", amount: 1 }), /invalid date/);
	assert.throws(() => l.record({ date: "2026-01-01T00:00:00Z", from: "bank", to: "nope", amount: 1 }), /unknown account/);
	assert.throws(() => l.record({ date: "2026-01-01T00:00:00Z", from: "bank", to: "food", amount: 1.5 }), /positive integer/);
});

test("entries are read-only", () => {
	const l = household();
	l.record({ date: "2026-01-01T00:00:00Z", from: "salary", to: "bank", amount: 100 });
	l.entries.push({});
	assert.equal(l.entries.length, 1);
	assert.throws(() => {
		"use strict";
		l.entries[0].amount = 5;
	});
});
