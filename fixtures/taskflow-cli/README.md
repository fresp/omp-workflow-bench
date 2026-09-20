# taskflow

Tiny personal task manager for the terminal.

```
taskflow add "Write report" --due 2026-03-01 --tags work,writing
taskflow list [--all] [--tag work]
taskflow done 3
taskflow remove 3
```

Data lives in `$TASKFLOW_HOME/tasks.json` (default `~/.taskflow/tasks.json`).

## Layout

| Path | What |
| --- | --- |
| `bin/taskflow.mjs` | entry point |
| `src/cli.mjs` | `run(argv, io)` — parses args and dispatches to a command; returns the exit code |
| `src/args.mjs` | minimal argv parser (`--flag value`, `--flag=value`, positionals) |
| `src/commands/*.mjs` | one file per command, each exports `run(args, io)` |
| `src/format/table.mjs` | plain-text table renderer used by `list` |
| `src/dates.mjs` | date helpers (dates are `YYYY-MM-DD` strings, calendar dates, no time zone) |
| `src/paths.mjs` | where the data file lives |

## Data format

```json
{ "nextId": 4, "tasks": [ { "id": 1, "title": "…", "done": false, "due": "2026-03-01", "tags": "work,writing", "createdAt": "…" } ] }
```

`due` is optional (`null` when unset). `tags` is a comma-separated string (`""` when unset).

## Conventions

- Commands write user-facing output to `io.stdout` / `io.stderr` (never `console.*`) and return an
  exit code: `0` success, `1` user error (bad input, unknown id).
- Error messages go to stderr and start with `Error: `.
- Tests run the real CLI through `test/helpers.mjs` with a temporary `TASKFLOW_HOME`.
