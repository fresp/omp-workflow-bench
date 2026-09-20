import { parseAmount } from "../money.mjs";

const HEADER = ["date", "description", "from", "to", "amount"];

/**
 * Import transfers from CSV text with the header `date,description,from,to,amount`.
 * Blank lines are skipped. Throws `Line N: …` (1-based, header is line 1) on a bad row.
 * @returns {number} entries posted
 */
export function importCsv(ledger, text) {
	const lines = text.split("\n");
	const header = lines[0].trim().split(",");
	if (header.join(",") !== HEADER.join(",")) {
		throw new Error(`Line 1: expected header "${HEADER.join(",")}"`);
	}
	let posted = 0;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line === "") continue;
		const cols = line.split(",");
		if (cols.length !== HEADER.length) throw new Error(`Line ${i + 1}: expected ${HEADER.length} columns, got ${cols.length}`);
		const [date, description, from, to, amountText] = cols;
		let amount;
		try {
			amount = parseAmount(amountText);
		} catch {
			throw new Error(`Line ${i + 1}: invalid amount ${JSON.stringify(amountText)}`);
		}
		ledger.post({ date, description, from, to, amount });
		posted++;
	}
	return posted;
}
