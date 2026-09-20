import { balanceSheet } from "./balance.mjs";

/** Summed balances per account type. */
export function totalsByType(ledger) {
	const totals = { asset: 0, liability: 0, income: 0, expense: 0, equity: 0 };
	for (const row of balanceSheet(ledger)) totals[row.type] += row.balance;
	return totals;
}
