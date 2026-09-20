# Persona — maintainer of ledger-lib (used by a personal-finance app in Indonesia)

Facts you know (answer only what you are asked; if asked about something not listed, say you have
no preference and the engineer should choose something sensible):

- Return an array of `{ month: "YYYY-MM", income, expense, net }`, sorted by month ascending. Amounts in integer cents. `net = income - expense`.
- Income = transfers whose `from` account has type `income`. Expense = transfers whose `to` account has type `expense`.
- Everything else is excluded: transfers between asset/liability accounts (e.g. bank → wallet, paying the credit card) are neither income nor expense.
- Refunds (from an expense account back to an asset) are out of scope — don't net them, just ignore them.
- The month is determined in Indonesia time (Asia/Jakarta, UTC+07:00, no daylight saving), regardless of the offset the date string was written with. `2026-01-31T20:00:00Z` is Feb 1st in Jakarta → month `2026-02`.
- Include months with no activity between the first and last month that has activity, with zeros (charts need a continuous axis). An empty ledger returns `[]`.
- Optional second argument `{ from: "YYYY-MM", to: "YYYY-MM" }` (both inclusive, either optional) limits the months returned; when given, months inside the range with no activity still appear with zeros, covering exactly from..to (when both are given).
- Export it from `src/index.mjs` and document it in the README; add tests.
