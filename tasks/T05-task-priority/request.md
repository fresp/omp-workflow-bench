Add priorities to tasks.

- `taskflow add "title" --priority high|medium|low` — default `medium`. Any other value is an error
  (`Error: invalid --priority "<value>" (expected high, medium or low)`, exit code 1).
- `taskflow list` shows a `PRIORITY` column (the word: high / medium / low) right after `TITLE`, and
  sorts tasks by priority (high first), then by id.
- `taskflow list --priority high` shows only tasks with that priority; it combines with `--tag` and `--all`.
