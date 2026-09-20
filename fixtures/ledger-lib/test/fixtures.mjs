import { Ledger } from "../src/index.mjs";

export function household() {
	return new Ledger({
		accounts: [
			{ id: "salary", name: "Salary", type: "income" },
			{ id: "bank", name: "Bank", type: "asset" },
			{ id: "wallet", name: "Wallet", type: "asset" },
			{ id: "card", name: "Credit card", type: "liability" },
			{ id: "food", name: "Groceries", type: "expense" },
			{ id: "rent", name: "Rent", type: "expense" },
		],
	});
}
