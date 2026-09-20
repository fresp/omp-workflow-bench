/**
 * Render rows as a left-aligned plain-text table.
 * @param {string[]} headers
 * @param {string[][]} rows
 */
export function renderTable(headers, rows) {
	const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)));
	const line = (cells) => cells.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  ").trimEnd();
	return [line(headers), ...rows.map(line)].join("\n");
}
