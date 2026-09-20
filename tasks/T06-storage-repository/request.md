Refactor: every command in `src/commands/` reads and writes `tasks.json` with its own copy of the
`fs` code. Pull that into one module, `src/storage/task-repository.mjs`, exporting
`createTaskRepository(env)` which returns `{ load(), save(data) }` (synchronous is fine).

- Commands must no longer import `node:fs` themselves.
- `save` must be atomic: a crash mid-write must never leave a truncated `tasks.json`.
- No user-visible behaviour change.
