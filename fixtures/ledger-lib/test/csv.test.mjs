import { test } from "node:test";
import assert from "node:assert/strict";
import { importCsv } from "../src/index.mjs";
import { household } from "./fixtures.mjs";

test("imports simple rows", () => {
	const l = household();
	const n = importCsv(
		l,
		"date,description,from,to,amount\n2026-01-25T09:00:00+07:00,Salary,salary,bank,5000.00\n\n2026-01-26T10:00:00+07:00,Food,bank,food,12.50\n",
	);
	assert.equal(n, 2);
	assert.equal(l.balance("bank"), 498750);
});

test("reports the line number of a bad amount", () => {
	const l = household();
	assert.throws(
		() => importCsv(l, "date,description,from,to,amount\n2026-01-25T09:00:00Z,x,salary,bank,abc\n"),
		/^Error: Line 2: invalid amount/,
	);
});

test("rejects a wrong header", () => {
	assert.throws(() => importCsv(household(), "a,b\n"), /Line 1/);
});
