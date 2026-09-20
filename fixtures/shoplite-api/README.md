# shoplite-api

Small storefront HTTP API built on `node:http` with zero runtime dependencies.

```
npm start      # listens on $PORT (default 3000)
npm test       # node --test
```

## Layout

| Path | What |
| --- | --- |
| `src/app.mjs` | `createApp(options)` — builds the router, middleware chain and routes; returns the request handler |
| `src/router.mjs` | tiny router: `get/post/...(pattern, handler)`, `:param` segments, `use(middleware)` |
| `src/routes/*.mjs` | route modules, each exports `register(router, deps)` |
| `src/services/pricing.mjs` | all money maths lives here |
| `src/store/memory-store.mjs` | in-memory store (products, orders) |
| `src/lib/errors.mjs` | `HttpError` + helpers; the only way handlers should signal errors |
| `src/lib/clock.mjs` | `now()` — use this instead of `Date.now()` so tests can control time |

## Conventions

- **Money is always integer cents.** Never store or return floats for money.
- **Pricing rule:** a percentage discount is applied to the *line total* (`unitPrice × quantity`)
  and rounded **once**, half-up, to whole cents. Never round per unit.
- **Errors** are JSON: `{ "error": { "code": "SOME_CODE", "message": "human text" } }`. Throw an
  `HttpError` (or use the helpers in `src/lib/errors.mjs`); `app.mjs` turns it into a response.
  Codes are `UPPER_SNAKE_CASE`.
- **Time:** read the current time through `src/lib/clock.mjs` (`now()`), never `Date.now()`
  directly. Tests call `setNow(ms)` / `resetClock()`.
- Tests boot the app in-process on a random port via `test/helpers.mjs` (`startApp()`).

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | `{ "status": "ok" }` |
| GET | `/products` | optional `?q=` (name contains, case-insensitive) and `?category=` filters; returns an array |
| GET | `/products/:id` | 404 `NOT_FOUND` if missing |
| POST | `/products` | `{ name, category, priceCents, discountPercent? }` → 201 |
| POST | `/orders` | `{ items: [{ productId, quantity }] }` → 201 with priced order |
| GET | `/orders/:id` | 404 `NOT_FOUND` if missing |
