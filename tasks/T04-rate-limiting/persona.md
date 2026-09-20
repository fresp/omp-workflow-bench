# Persona — tech lead of shoplite-api

You want rate limiting before the partner launch. Facts you know (answer only what you are asked;
if asked about something not listed here, say you have no preference and the engineer should pick
something sensible):

- Partners identify themselves with an `x-api-key` header. Limit per API key. Requests without a key are limited per client IP address (the socket's remote address) instead.
- Limit: 60 requests per 60 seconds, as a fixed window aligned to the clock (window = floor(now / 60000)); not a sliding window or token bucket.
- It applies to every route except `GET /health` (load balancer health checks must never be limited).
- When over the limit: HTTP 429, the standard JSON error body with code `RATE_LIMITED`, and a `Retry-After` header with the whole number of seconds until the current window ends (rounded up).
- Every response on a limited route carries `X-RateLimit-Limit` (the limit) and `X-RateLimit-Remaining` (requests left in the window after this one, never negative).
- Requests that are rejected with 429 do not consume extra quota.
- In-memory counters per app instance are fine — no Redis, we run a single instance.
- Time must come from `src/lib/clock.mjs` so tests can move time.
- Making the numbers configurable via `createApp` options is nice to have, not required; defaults must be 60 per 60s.
- Please document it in the README and add tests.
