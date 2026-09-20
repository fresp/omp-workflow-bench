import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAmount, formatAmount } from "../src/index.mjs";

test("parseAmount", () => {
	assert.equal(parseAmount("12.34"), 1234);
	assert.equal(parseAmount("7"), 700);
	assert.equal(parseAmount("0.5"), 50);
	assert.equal(parseAmount("-3.10"), -310);
	assert.throws(() => parseAmount("1,000"));
});

test("formatAmount", () => {
	assert.equal(formatAmount(1234), "12.34");
	assert.equal(formatAmount(-50), "-0.50");
	assert.equal(formatAmount(0), "0.00");
});
