import { test } from "node:test";
import assert from "node:assert/strict";
import * as lib from "../../src/index.mjs";
import { household } from "../fixtures.mjs";

const { monthlyReport } = lib;

function sample() {
	const l = household();
	l.post({ date: "2026-01-25T09:00:00+07:00", description: "Salary Jan", from: "salary", to: "bank", amount: 500000 });
	l.post({ date: "2026-01-26T10:00:00+07:00", description: "Food", from: "bank", to: "food", amount: 12500 });
	l.post({ date: "2026-01-27T10:00:00+07:00", description: "ATM", from: "bank", to: "wallet", amount: 20000 }); // transfer: excluded
	l.post({ date: "2026-01-28T10:00:00+07:00", description: "Rent on card", from: "card", to: "rent", amount: 300000 }); // expense via liability
	l.post({ date: "2026-01-29T10:00:00+07:00", description: "Pay card", from: "bank", to: "card", amount: 300000 }); // transfer: excluded
	l.post({ date: "2026-03-25T09:00:00+07:00", description: "Salary Mar", from: "salary", to: "bank", amount: 510000 });
	l.post({ date: "2026-03-26T10:00:00+07:00", description: "Refund", from: "food", to: "bank", amount: 1000 }); // refund: ignored
	return l;
}

test("monthlyReport is exported", () => {
	assert.equal(typeof monthlyReport, "function");
});

test("income/expense per month, transfers and refunds excluded, gap months filled", () => {
	assert.deepEqual(monthlyReport(sample()), [
		{ month: "2026-01", income: 500000, expense: 312500, net: 187500 },
		{ month: "2026-02", income: 0, expense: 0, net: 0 },
		{ month: "2026-03", income: 510000, expense: 0, net: 510000 },
	]);
});

test("months are bucketed in Asia/Jakarta time regardless of the stored offset", () => {
	const l = household();
	l.post({ date: "2026-01-31T20:00:00Z", description: "late UTC", from: "salary", to: "bank", amount: 100 }); // Feb 1 03:00 WIB
	l.post({ date: "2026-02-28T16:59:59Z", description: "Feb 28 23:59 WIB", from: "bank", to: "food", amount: 7 });
	l.post({ date: "2026-02-28T17:00:00Z", description: "Mar 1 00:00 WIB", from: "bank", to: "food", amount: 3 });
	l.post({ date: "2026-03-01T01:00:00+09:00", description: "Tokyo 01:00 Mar 1 = Feb 28 23:00 WIB", from: "bank", to: "food", amount: 11 });
	assert.deepEqual(monthlyReport(l), [
		{ month: "2026-02", income: 100, expense: 18, net: 82 },
		{ month: "2026-03", income: 0, expense: 3, net: -3 },
	]);
});

test("empty ledger → []", () => {
	assert.deepEqual(monthlyReport(household()), []);
});

test("year boundary gap fill", () => {
	const l = household();
	l.post({ date: "2025-11-10T10:00:00+07:00", from: "salary", to: "bank", amount: 1 });
	l.post({ date: "2026-02-10T10:00:00+07:00", from: "bank", to: "food", amount: 1 });
	assert.deepEqual(monthlyReport(l).map((r) => r.month), ["2025-11", "2025-12", "2026-01", "2026-02"]);
});

test("from/to are inclusive and cover exactly the requested span", () => {
	const l = sample();
	assert.deepEqual(monthlyReport(l, { from: "2026-02", to: "2026-03" }), [
		{ month: "2026-02", income: 0, expense: 0, net: 0 },
		{ month: "2026-03", income: 510000, expense: 0, net: 510000 },
	]);
	assert.deepEqual(
		monthlyReport(l, { from: "2025-12", to: "2026-01" }),
		[
			{ month: "2025-12", income: 0, expense: 0, net: 0 },
			{ month: "2026-01", income: 500000, expense: 312500, net: 187500 },
		],
	);
	assert.deepEqual(monthlyReport(l, { to: "2026-01" }).map((r) => r.month), ["2026-01"]);
	assert.deepEqual(monthlyReport(l, { from: "2026-03" }).map((r) => r.month), ["2026-03"]);
});
