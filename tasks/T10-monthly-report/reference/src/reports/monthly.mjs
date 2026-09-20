const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000; // Asia/Jakarta: UTC+07:00, no DST

/** "YYYY-MM" of an ISO timestamp, in Jakarta time. */
export function jakartaMonth(iso) {
	const d = new Date(Date.parse(iso) + JAKARTA_OFFSET_MS);
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function nextMonth(month) {
	let [y, m] = month.split("-").map(Number);
	m += 1;
	if (m === 13) {
		m = 1;
		y += 1;
	}
	return `${y}-${String(m).padStart(2, "0")}`;
}

/**
 * Income vs expense per month (Asia/Jakarta). Income = from an income account; expense = to an
 * expense account; everything else (asset/liability transfers, refunds) is ignored.
 * @param {import("../ledger.mjs").Ledger} ledger
 * @param {{ from?: string, to?: string }} [range] inclusive "YYYY-MM" bounds
 */
export function monthlyReport(ledger, range = {}) {
	const totals = new Map();
	for (const e of ledger.entries) {
		const fromType = ledger.getAccount(e.from).type;
		const toType = ledger.getAccount(e.to).type;
		const income = fromType === "income" ? e.amount : 0;
		const expense = toType === "expense" ? e.amount : 0;
		if (!income && !expense) continue;
		const month = jakartaMonth(e.date);
		const t = totals.get(month) ?? { income: 0, expense: 0 };
		t.income += income;
		t.expense += expense;
		totals.set(month, t);
	}
	const active = [...totals.keys()].sort();
	const start = range.from ?? active[0];
	const end = range.to ?? active.at(-1);
	if (!start || !end || start > end) return [];
	const rows = [];
	for (let m = start; m <= end; m = nextMonth(m)) {
		const t = totals.get(m) ?? { income: 0, expense: 0 };
		rows.push({ month: m, income: t.income, expense: t.expense, net: t.income - t.expense });
	}
	return rows;
}
