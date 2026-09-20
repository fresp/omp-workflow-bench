Add sorting to `GET /products` via a `sort` query parameter.

Supported values:
- `price_asc` — cheapest first, by `priceCents`
- `price_desc` — most expensive first, by `priceCents`
- `name` — alphabetical by `name`, case-insensitive

Without `sort` the current order (creation order) stays as it is. Any other value must be rejected
with HTTP 400 and the standard error body, error code `INVALID_QUERY`.
