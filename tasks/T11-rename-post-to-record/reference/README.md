# ledger-lib

Small bookkeeping library. Every movement of money is a **transfer** from one account to another.

```js
import { Ledger } from "ledger-lib";

const ledger = new Ledger();
ledger.addAccount({ id: "salary", name: "Salary", type: "income" });
ledger.addAccount({ id: "bank", name: "Bank", type: "asset" });
ledger.addAccount({ id: "food", name: "Groceries", type: "expense" });

ledger.record({ date: "2026-01-25T09:00:00+07:00", description: "January salary", from: "salary", to: "bank", amount: 1500000 });
ledger.record({ date: "2026-01-26T18:30:00+07:00", description: "Groceries", from: "bank", to: "food", amount: 42050 });

ledger.balance("bank"); // 1457950  (cents)
```

## Concepts

- **Amounts are integer cents** everywhere. `parseAmount("12.34") === 1234`, `formatAmount(1234) === "12.34"`.
- **Account types:** `asset`, `liability`, `income`, `expense`, `equity`.
- **Balance** of an account = everything transferred *to* it minus everything transferred *from* it.
- **Dates** are ISO-8601 strings with an offset (`Z` or `+07:00`). Stored as given.

## API

| Export | What |
| --- | --- |
| `Ledger` | `addAccount({id,name,type})`, `getAccount(id)`, `accounts`, `record({date,description,from,to,amount})` → entry (`post()` is a deprecated alias — see below), `entries`, `balance(accountId)` |
| `importCsv(ledger, text)` | imports rows `date,description,from,to,amount` (amount as `12.34`); returns the number of entries posted |
| `balanceSheet(ledger)` | `[{ id, name, type, balance }]` for every account |
| `totalsByType(ledger)` | `{ asset, liability, income, expense, equity }` summed balances |
| `parseAmount`, `formatAmount` | money helpers |

## Layout

`src/ledger.mjs` (core), `src/money.mjs`, `src/importers/csv.mjs`, `src/reports/*.mjs`,
`src/index.mjs` (public exports), `examples/basic.mjs`.

## Deprecations

- `Ledger.post()` is deprecated since 2.2 in favour of `Ledger.record()` (same signature). It still
  works but emits a `DeprecationWarning` (code `LEDGER_DEP_POST`) once per process, and will be
  removed in the next major version.
