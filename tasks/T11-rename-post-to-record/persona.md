# Persona — maintainer of ledger-lib

Facts you know (answer only what you are asked):

- The warning type must be `DeprecationWarning` (so `--no-deprecation` silences it) and the message should tell people to use `record()` instead.
- `post()` must return exactly what `record()` returns (the frozen entry) and throw the same errors.
- Existing tests that call `post()` should be moved to `record()`; keep one test for the deprecated alias.
- Add a CHANGELOG.md entry under a new "Unreleased" heading (the file doesn't exist yet — create it).
- Don't bump the version in package.json; release tooling does that.
