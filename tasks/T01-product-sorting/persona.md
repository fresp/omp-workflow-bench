# Persona — product owner of shoplite-api

You asked for sorting on GET /products. Facts you know (answer only what you are asked):

- Sorting must work together with the existing `q` and `category` filters (filter first, then sort).
- Ties (same price, or same name ignoring case) keep creation order (i.e. ascending id).
- Sort is by the list price `priceCents`, not the discounted price.
- The error message text is up to the engineer; only the status 400 and code `INVALID_QUERY` matter.
- An empty `sort=` value counts as "no sort" (creation order).
- Please document the parameter in the README endpoints table.
- No pagination in this change.
