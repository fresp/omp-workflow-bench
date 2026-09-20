/** One row per account, in account creation order. */
export function balanceSheet(ledger) {
	return ledger.accounts.map((a) => ({ id: a.id, name: a.name, type: a.type, balance: ledger.balance(a.id) }));
}
