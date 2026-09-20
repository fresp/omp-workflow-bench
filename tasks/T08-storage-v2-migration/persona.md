# Persona — the taskflow maintainer

Facts you know (answer only what you are asked):

- The backup must be a byte-for-byte copy of the original v1 file.
- If `tasks.v1.bak.json` already exists, never overwrite it (keep the oldest backup).
- Migration happens on ANY command that loads the file, including read-only ones like `list`.
- v1 tags: split on commas, trim whitespace, drop empty entries (`" a, ,b "` → `["a","b"]`; `""` → `[]`). A missing `tags` field becomes `[]`.
- All other task fields are kept unchanged (including unknown extra fields).
- If a file has a `schemaVersion` greater than 2, refuse to touch it: exit code 1 with an error starting `Error: ` that says it was written by a newer version of taskflow. Don't modify or back it up.
- Keep 2-space JSON formatting.
- `list` still shows tags comma-joined in the TAGS column (`work,writing`), and `list --tag x` keeps working.
- Put the migration logic in one place (e.g. a storage module), not in each command.
