import { Ledger, balanceSheet, formatAmount } from "../src/index.mjs";

const ledger = new Ledger({
	accounts: [
		{ id: "salary", name: "Salary", type: "income" },
		{ id: "bank", name: "Bank", type: "asset" },
		{ id: "food", name: "Groceries", type: "expense" },
	],
});

ledger.record({ date: "2026-01-25T09:00:00+07:00", description: "January salary", from: "salary", to: "bank", amount: 1500000 });
ledger.record({ date: "2026-01-26T18:30:00+07:00", description: "Groceries", from: "bank", to: "food", amount: 42050 });

for (const row of balanceSheet(ledger)) {
	console.log(`${row.name.padEnd(10)} ${formatAmount(row.balance).padStart(12)}`);
}
