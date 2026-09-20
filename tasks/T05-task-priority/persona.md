# Persona — the taskflow maintainer

Facts you know (answer only what you are asked):

- Users already have tasks.json files with tasks that have no `priority` field. Those tasks must behave exactly like `medium` everywhere (shown as medium, filtered as medium, sorted as medium). Do not require a migration step.
- Store the priority on the task as the lowercase word (`"priority": "high"`).
- `--priority` values are case-insensitive on input (`--priority HIGH` works) but stored lowercase.
- An invalid value for `list --priority` is also an error with the same message format, exit code 1.
- Update the usage text in `src/cli.mjs` and the README.
- No changes to `done` or `remove`.
