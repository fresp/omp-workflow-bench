# Persona — the user who filed issue #212

Facts you know (answer only what you are asked):

- The file comes from Excel: it starts with a UTF-8 byte-order mark (BOM) and uses CRLF (`\r\n`) line endings. Both must work.
- Descriptions can contain commas, doubled quotes for a literal quote (`"He said ""hi"""` → `He said "hi"`), and occasionally a line break inside a quoted field (multi-line memo).
- Whitespace around unquoted fields doesn't matter (trim it); inside quotes it must be kept as-is.
- Blank lines should still be skipped.
- Error messages must keep the `Line N: …` format, where N is the physical line (1-based, header = line 1) on which the bad record STARTS.
- An unterminated quote (file ends inside quotes) must be an error `Line N: unterminated quoted field` pointing at the line where that field started — not a silent partial import.
- If any row fails, nothing from that file should be posted (all-or-nothing) — today a failure halfway leaves the first rows posted, which is part of the problem.
- No external CSV library (the package has zero runtime dependencies on purpose).
