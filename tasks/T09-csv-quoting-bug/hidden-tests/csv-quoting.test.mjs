import { test } from "node:test";
import assert from "node:assert/strict";
import { importCsv } from "../../src/index.mjs";
import { household } from "../fixtures.mjs";

const HEADER = "date,description,from,to,amount";

test("the issue's row: a quoted description containing commas", () => {
	const l = household();
	const csv = [
		HEADER,
		"2026-02-01T09:00:00+07:00,Salary,salary,bank,1000.00",
		"2026-02-02T09:00:00+07:00,Rent,bank,rent,400.00",
		'2026-02-03T10:15:00+07:00,"Coffee, beans and filters",bank,food,23.40',
	].join("\n");
	assert.equal(importCsv(l, csv), 3);
	assert.equal(l.entries[2].description, "Coffee, beans and filters");
	assert.equal(l.entries[2].amount, 2340);
});

test("doubled quotes inside a quoted field are a literal quote", () => {
	const l = household();
	importCsv(l, `${HEADER}\n2026-02-01T09:00:00Z,"He said ""hi""",salary,bank,1.00\n`);
	assert.equal(l.entries[0].description, 'He said "hi"');
});

test("a quoted field may contain a line break", () => {
	const l = household();
	const n = importCsv(l, `${HEADER}\n2026-02-01T09:00:00Z,"Multi\nline memo",salary,bank,1.00\n2026-02-02T09:00:00Z,Next,bank,food,0.50\n`);
	assert.equal(n, 2);
	assert.equal(l.entries[0].description, "Multi\nline memo");
	assert.equal(l.balance("bank"), 50);
});

test("Excel export: BOM + CRLF", () => {
	const l = household();
	const csv = `﻿${HEADER}\r\n2026-02-01T09:00:00Z,"Coffee, beans",salary,bank,5.00\r\n\r\n2026-02-02T09:00:00Z,Plain,bank,food,1.25\r\n`;
	assert.equal(importCsv(l, csv), 2);
	assert.equal(l.entries[0].description, "Coffee, beans");
	assert.equal(l.entries[1].description, "Plain");
	assert.equal(l.entries[1].amount, 125);
});

test("unquoted fields are trimmed; quoted content is kept as-is", () => {
	const l = household();
	importCsv(l, `${HEADER}\n 2026-02-01T09:00:00Z , "  padded  " , salary , bank , 2.00 \n`);
	assert.equal(l.entries[0].description, "  padded  ");
	assert.equal(l.entries[0].from, "salary");
	assert.equal(l.entries[0].amount, 200);
});

test("error line numbers refer to the physical line where the record starts", () => {
	const l = household();
	const csv = `${HEADER}\n2026-02-01T09:00:00Z,"two\nlines",salary,bank,1.00\n2026-02-02T09:00:00Z,bad,bank,food,abc\n`;
	assert.throws(() => importCsv(l, csv), /^Error: Line 4: invalid amount/);
});

test("an unterminated quote is an error at the line where it started", () => {
	const l = household();
	const csv = `${HEADER}\n2026-02-01T09:00:00Z,ok,salary,bank,1.00\n2026-02-02T09:00:00Z,"never closed,bank,food,1.00\nmore\n`;
	assert.throws(() => importCsv(l, csv), /^Error: Line 3: unterminated quoted field/);
});

test("import is all-or-nothing", () => {
	const l = household();
	const csv = `${HEADER}\n2026-02-01T09:00:00Z,ok,salary,bank,1.00\n2026-02-02T09:00:00Z,bad,bank,nowhere,1.00\n`;
	assert.throws(() => importCsv(l, csv));
	assert.equal(l.entries.length, 0);
	assert.equal(l.balance("bank"), 0);
});

test("still rejects rows with the wrong number of columns", () => {
	const l = household();
	assert.throws(() => importCsv(l, `${HEADER}\n2026-02-01T09:00:00Z,"a,b",salary,bank\n`), /^Error: Line 2: expected 5 columns, got 4/);
});
