// Canonical token accounting, shared by compile.mjs and scripts/check-tokens.mjs.
//
// A run's token cost = the sum, over DEDUPLICATED assistant messages, of
// usage.totalTokens (input + cacheRead + cacheWrite + output) parsed from rpc.ndjson. The same
// usage object is repeated on message_start / message_end / turn_end, so frames must be deduplicated
// by message.responseId (else a timestamp+usage hash) or the total triples.
//
// omp's get_session_stats `total.total` is a CLIENT counter that resets when the context is
// compacted mid-run, so it undercounts; subtractTokens(final, prep) then goes negative for exec.
// The /plan arm never compacts, so its client total equals the canonical total exactly.
import { existsSync, readFileSync } from "node:fs";

export function canonicalTokens(file) {
	if (!existsSync(file)) return null;
	const seen = new Set();
	let total = 0;
	let input = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let output = 0;
	let messages = 0;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		let f;
		try {
			f = JSON.parse(line);
		} catch {
			continue;
		}
		if (f.type !== "message_end" || f.message?.role !== "assistant") continue;
		const u = f.message.usage ?? {};
		const key = f.message.responseId ?? `${f.message.timestamp}|${JSON.stringify(u)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		total += u.totalTokens ?? 0;
		input += u.input ?? 0;
		cacheRead += u.cacheRead ?? 0;
		cacheWrite += u.cacheWrite ?? 0;
		output += u.output ?? 0;
		messages++;
	}
	return { total, input, cacheRead, cacheWrite, output, messages };
}
