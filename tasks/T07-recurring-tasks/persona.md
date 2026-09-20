# Persona — the taskflow maintainer

You want recurring tasks. Facts you know (answer only what you are asked; if asked about something
not listed, say you have no preference and the engineer should choose something sensible):

- Supported values: `--every day`, `--every week`, `--every month`. Nothing fancier (no "every 2 weeks", no weekdays, no cron).
- Any other value → error, exit 1, message `Error: invalid --every "<value>" (expected day, week or month)`.
- A recurring task must have a due date. `--every` without `--due` → error, exit 1 (`Error: --every needs a --due date`).
- Store it on the task as `"every": "week"` (absent/null for normal tasks).
- There is no background scheduler. Recurrence happens when the user completes the task: `taskflow done <id>` marks it done as today AND creates the next occurrence as a new task (new id) with the same title, tags and recurrence.
- The next due date is computed from the PREVIOUS DUE DATE, not from the day it was completed (so completing late doesn't shift the schedule).
- Monthly recurrence on the 29th–31st clamps to the last day of a shorter month (2026-01-31 → 2026-02-28; leap years give the 29th). Each step is computed from the previous due date, so after a clamp the series stays on the clamped day (2026-02-28 → 2026-03-28). Keep it that simple.
- `done` prints the usual `Completed #<id>: <title>` line and then `Next: #<newId> due <YYYY-MM-DD>`.
- `list` shows recurring tasks with ` (every week)` / ` (every day)` / ` (every month)` appended to the title.
- `remove` deletes only that one task; it does not stop anything else.
- Completing a task that is already done must not create another occurrence.
- Update usage text and README; add tests.
