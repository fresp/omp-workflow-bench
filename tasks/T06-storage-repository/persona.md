# Persona — the taskflow maintainer

Facts you know (answer only what you are asked):

- `load()` on a missing file returns a fresh `{ nextId: 1, tasks: [] }` and does not create the file.
- `save()` creates the data directory if needed.
- Atomic means: write to a temporary file in the same directory, then rename it over `tasks.json`. No temp files may be left behind after a successful save.
- Keep the JSON formatting as it is today (2-space indent).
- If `tasks.json` contains invalid JSON, commands should fail with exit code 1 and a message starting with `Error: ` that mentions the file path — today they crash with a stack trace, which we consider a bug worth fixing in this refactor.
- Don't change the data format or the CLI output.
