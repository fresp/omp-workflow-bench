The personal-finance app built on this library has users with 50k+ transfers, and anything that
shows balances (`ledger.balance()`, `balanceSheet()`, `totalsByType()`) has become painfully slow.
Make balance lookups fast without changing the public API.
