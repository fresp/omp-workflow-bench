let warnedPost = false;

const ACCOUNT_TYPES = new Set(["asset", "liability", "income", "expense", "equity"]);

export class Ledger {
	#accounts = new Map();
	#entries = [];
	#nextId = 1;

	/** @param {{ accounts?: Array<{id:string,name:string,type:string}> }} [options] */
	constructor(options = {}) {
		for (const account of options.accounts ?? []) this.addAccount(account);
	}

	addAccount({ id, name, type }) {
		if (typeof id !== "string" || id === "") throw new Error("account id must be a non-empty string");
		if (!ACCOUNT_TYPES.has(type)) throw new Error(`unknown account type: ${type}`);
		if (this.#accounts.has(id)) throw new Error(`duplicate account: ${id}`);
		const account = Object.freeze({ id, name: name ?? id, type });
		this.#accounts.set(id, account);
		return account;
	}

	getAccount(id) {
		return this.#accounts.get(id) ?? null;
	}

	get accounts() {
		return [...this.#accounts.values()];
	}

	/** Read-only view of every entry, in posting order. */
	get entries() {
		return this.#entries.slice();
	}

	/**
	 * Record a transfer of `amount` cents from one account to another.
	 * @returns the frozen entry
	 */
	record({ date, description = "", from, to, amount }) {
		if (typeof date !== "string" || Number.isNaN(Date.parse(date))) throw new Error(`invalid date: ${date}`);
		if (!this.#accounts.has(from)) throw new Error(`unknown account: ${from}`);
		if (!this.#accounts.has(to)) throw new Error(`unknown account: ${to}`);
		if (from === to) throw new Error("from and to must differ");
		if (!Number.isInteger(amount) || amount <= 0) throw new Error("amount must be a positive integer (cents)");
		const entry = Object.freeze({ id: this.#nextId++, date, description, from, to, amount });
		this.#entries.push(entry);
		return entry;
	}

	/**
	 * @deprecated since 2.2 — use {@link Ledger#record}. Emits a DeprecationWarning once per process.
	 */
	post(transfer) {
		if (!warnedPost) {
			warnedPost = true;
			process.emitWarning("Ledger.post() is deprecated; use Ledger.record() instead.", {
				type: "DeprecationWarning",
				code: "LEDGER_DEP_POST",
			});
		}
		return this.record(transfer);
	}

	/** Everything transferred to the account minus everything transferred from it. */
	balance(accountId) {
		if (!this.#accounts.has(accountId)) throw new Error(`unknown account: ${accountId}`);
		let total = 0;
		for (const e of this.#entries) {
			if (e.to === accountId) total += e.amount;
			if (e.from === accountId) total -= e.amount;
		}
		return total;
	}
}
