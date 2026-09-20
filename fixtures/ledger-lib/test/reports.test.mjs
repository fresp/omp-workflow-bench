import { test } from "node:test";
import assert from "node:assert/strict";
import { balanceSheet, totalsByType } from "../src/index.mjs";
import { household } from "./fixtures.mjs";

test("balanceSheet + totalsByType", () => {
	const l = household();
	l.post({ date: "2026-01-25T09:00:00Z", from: "salary", to: "bank", amount: 1000 });
	l.post({ date: "2026-01-26T09:00:00Z", from: "bank", to: "rent", amount: 400 });
	l.post({ date: "2026-01-27T09:00:00Z", from: "card", to: "food", amount: 50 });
	const sheet = balanceSheet(l);
	assert.deepEqual(sheet.find((r) => r.id === "bank"), { id: "bank", name: "Bank", type: "asset", balance: 600 });
	assert.deepEqual(totalsByType(l), { asset: 600, liability: -50, income: -1000, expense: 450, equity: 0 });
});
