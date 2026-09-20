/**
 * Minimal argv parser.
 *   ["add", "Buy milk", "--due", "2026-01-02", "--all"] →
 *   { _: ["add", "Buy milk"], flags: { due: "2026-01-02", all: true } }
 * A flag followed by another flag (or nothing) is boolean `true`.
 */
export function parseArgs(argv) {
	const out = { _: [], flags: {} };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			if (eq !== -1) {
				out.flags[arg.slice(2, eq)] = arg.slice(eq + 1);
				continue;
			}
			const name = arg.slice(2);
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				out.flags[name] = next;
				i++;
			} else {
				out.flags[name] = true;
			}
		} else {
			out._.push(arg);
		}
	}
	return out;
}
