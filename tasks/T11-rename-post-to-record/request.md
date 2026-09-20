`Ledger.post()` is a confusing name (people think it does HTTP). Rename it to `Ledger.record()`.

- `record()` has exactly the same signature and behaviour.
- Keep `post()` working as a deprecated alias for one more major version: it must emit a Node
  deprecation warning (via `process.emitWarning`, code `LEDGER_DEP_POST`) — once per process, not on
  every call.
- Nothing inside this repo (library code, examples, README) should use `post()` any more, apart from
  documenting the deprecation.
