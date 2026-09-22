#!/usr/bin/env node
// Compare the canonical token definition against omp's own client totals, per run.
//
// Canonical: a run's token cost is the sum, over deduplicated assistant messages, of
// usage.totalTokens (input + cacheRead + cacheWrite + output) parsed from rpc.ndjson.
// omp's get_session_stats `total.total` is a CLIENT counter that resets when the context is
// compacted mid-run, so it undercounts — and subtractTokens(final, prep) then goes negative for
// exec. The /plan arm never compacts, so its two numbers agree exactly; readyset's do not.
//
//   node scripts/check-tokens.mjs [--label L] [--strict]
//
// Without --strict this only warns (exit 0) so it can run inside compile.sh; with --strict it
// exits non-zero when any run differs by more than the tolerance.
import { join } from "node:path";
import { parseArgs } from "node:util";
import { listRunDirs, readJson, resolveLabel } from "../harness/lib/results.mjs";
import { canonicalTokens } from "../harness/lib/tokens.mjs";

const { values: argv } = parseArgs({ strict: false, options: { label: { type: "string" }, strict: { type: "boolean", default: false }, tolerance: { type: "string", default: "0.02" } } });
const label = resolveLabel(argv.label);
const tolerance = Number(argv.tolerance);

const runs = listRunDirs(label);
if (!runs.length) {
	console.error(`no runs under results/${label}`);
	process.exit(2);
}

let warnings = 0;
let checked = 0;
const rows = [];
for (const r of runs) {
	const canon = canonicalTokens(join(r.dir, "rpc.ndjson"));
	if (!canon) continue;
	const metrics = readJson(join(r.dir, "metrics.json"), {});
	const client = metrics?.tokens?.total?.total ?? null;
	checked++;
	const diff = client == null || canon.total === 0 ? null : Math.abs(canon.total - client) / canon.total;
	const flagged = diff != null && diff > tolerance;
	if (flagged) warnings++;
	rows.push({ arm: r.arm, cell: r.cell, canon: canon.total, client, diff, flagged, messages: canon.messages });
}

const f = (x) => (x == null ? "—" : x.toLocaleString("en-US"));
for (const row of rows.filter((x) => x.flagged)) {
	console.log(`warn  ${row.cell.padEnd(52)} canonical ${f(row.canon).padStart(14)}  client ${f(row.client).padStart(14)}  Δ ${(row.diff * 100).toFixed(1)}%`);
}
const byArm = (arm) => {
	const mine = rows.filter((x) => x.arm === arm);
	return { n: mine.length, flagged: mine.filter((x) => x.flagged).length };
};
console.log(`\nchecked ${checked} run(s) · ${warnings} over ${(tolerance * 100).toFixed(0)}% tolerance`);
for (const arm of ["plan", "readyset"]) {
	const a = byArm(arm);
	if (a.n) console.log(`  ${arm.padEnd(9)} ${a.flagged}/${a.n} flagged`);
}
if (warnings && argv.strict) {
	console.error(`\n${warnings} run(s) differ from omp's client total beyond tolerance (strict).`);
	process.exit(1);
}
