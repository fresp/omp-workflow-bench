Issue #212 — "importCsv fails on bank exports"

> Our bank's export (opened and re-saved in Excel) fails to import:
> `Error: Line 4: expected 5 columns, got 6`. Line 4 is
> `2026-02-03T10:15:00+07:00,"Coffee, beans and filters",bank,food,23.40`.
> Other rows with quotes in the description also come out wrong.

Fix CSV import so it handles standard CSV (RFC 4180) quoting.
