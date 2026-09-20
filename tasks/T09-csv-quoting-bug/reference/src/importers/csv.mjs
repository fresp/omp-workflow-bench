import { parseAmount } from "../money.mjs";

const HEADER = ["date", "description", "from", "to", "amount"];

/**
 * RFC 4180 tokenizer. Returns records as { line, fields } where `line` is the 1-based physical line
 * the record starts on. Unquoted fields are trimmed; quoted content is kept verbatim.
 */
export function parseCsv(text) {
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
	const records = [];
	let fields = [];
	let field = "";
	let quoted = false; // current field was quoted
	let inQuotes = false;
	let line = 1;
	let recordLine = 1;
	let quoteLine = 1;
	let blank = true;

	const endField = () => {
		fields.push(quoted ? field : field.trim());
		field = "";
		quoted = false;
	};
	const endRecord = () => {
		endField();
		if (!(blank && fields.length === 1 && fields[0] === "")) records.push({ line: recordLine, fields });
		fields = [];
		blank = true;
	};

	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inQuotes) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else inQuotes = false;
			} else {
				if (c === "\n") line++;
				field += c;
			}
			continue;
		}
		if (c === '"' && field.trim() === "") {
			inQuotes = true;
			quoted = true;
			quoteLine = line;
			field = "";
			blank = false;
		} else if (c === ",") {
			endField();
			blank = false;
		} else if (c === "\r" && text[i + 1] === "\n") {
			// handled by the \n branch
		} else if (c === "\n") {
			endRecord();
			line++;
			recordLine = line;
		} else {
			if (c.trim() !== "") blank = false;
			if (!quoted) field += c;
		}
	}
	if (inQuotes) throw new Error(`Line ${quoteLine}: unterminated quoted field`);
	endRecord();
	return records;
}

/**
 * Import transfers from CSV text with the header `date,description,from,to,amount`.
 * All-or-nothing: every row is validated before anything is posted.
 * @returns {number} entries posted
 */
export function importCsv(ledger, text) {
	const records = parseCsv(text);
	const header = records[0]?.fields ?? [];
	if (header.join(",") !== HEADER.join(",")) {
		throw new Error(`Line 1: expected header "${HEADER.join(",")}"`);
	}
	const rows = [];
	for (const { line, fields } of records.slice(1)) {
		if (fields.length !== HEADER.length) throw new Error(`Line ${line}: expected ${HEADER.length} columns, got ${fields.length}`);
		const [date, description, from, to, amountText] = fields;
		let amount;
		try {
			amount = parseAmount(amountText);
		} catch {
			throw new Error(`Line ${line}: invalid amount ${JSON.stringify(amountText)}`);
		}
		if (!ledger.getAccount(from)) throw new Error(`Line ${line}: unknown account: ${from}`);
		if (!ledger.getAccount(to)) throw new Error(`Line ${line}: unknown account: ${to}`);
		if (Number.isNaN(Date.parse(date))) throw new Error(`Line ${line}: invalid date: ${date}`);
		if (from === to) throw new Error(`Line ${line}: from and to must differ`);
		if (amount <= 0) throw new Error(`Line ${line}: amount must be positive`);
		rows.push({ date, description, from, to, amount });
	}
	for (const row of rows) ledger.post(row);
	return rows.length;
}
