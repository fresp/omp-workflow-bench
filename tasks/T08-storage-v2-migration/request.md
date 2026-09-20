Move `tasks.json` to a v2 format:

```json
{ "schemaVersion": 2, "nextId": 4, "tasks": [ { "id": 1, "title": "…", "tags": ["work", "writing"], … } ] }
```

- `tags` becomes an array of strings instead of a comma-separated string.
- Files without `schemaVersion` are v1. When taskflow loads a v1 file it migrates it to v2, writes the
  v2 file back, and keeps a backup of the original file as `tasks.v1.bak.json` next to it.
- New files are written as v2 straight away.
- The CLI (`--tags a,b` input, `list` output) must look exactly the same as before.
