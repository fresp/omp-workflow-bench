# Persona — maintainer of ledger-lib

Facts you know (answer only what you are asked):

- The app calls `balance()` for every account on every screen render, and posts transfers in between. Balance lookups must be O(1) (or close) once the ledger is loaded; posting must stay cheap (no full recomputation per post).
- Correctness is non-negotiable: a balance read right after a `post()` must include that transfer.
- Entries are only ever added through `post()`. There is no delete/edit API and none is planned, so you don't need to handle removals.
- Extra memory for an index/cache is fine.
- Public API and behaviour must not change (same errors for unknown accounts, `entries` stays a read-only copy, entries stay frozen).
- A performance regression test is welcome, but it must not be flaky on slow CI machines (compare against a baseline rather than a hard millisecond limit).
- No new dependencies.
