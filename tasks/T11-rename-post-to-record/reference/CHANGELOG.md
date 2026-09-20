# Changelog

## Unreleased

- Renamed `Ledger.post()` to `Ledger.record()`. `post()` remains as a deprecated alias and emits a
  `DeprecationWarning` (`LEDGER_DEP_POST`) once per process.
