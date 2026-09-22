// Locks the prep-vs-final CONTEXT.md merge: the gate snapshot (prep/readyset-change/) is a
// prefix of the final tree (final/readyset/changes/) — reading only the first file truncates
// phaseSummary at gate:start (qc-sanity2: prep 7 markers vs final 19). phaseEvents() must merge
// all CONTEXT.md files and collapse exact duplicates.
// Run: node --test harness/test/context-phases.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextFiles, outcomeCounts, mechanismMetrics, phaseEvents, phaseSummary } from "../lib/context.mjs";

const marker = (ev) => `<!-- readyset-phase -->\n\`\`\`json\n${JSON.stringify(ev)}\n\`\`\`\n`;

// The shared prefix both files contain (identical JSON, must dedupe to one copy each).
const PREFIX = [
	{ phase: "grill", edge: "end", outcome: "grilled", at: "2026-09-22T14:54:29.919Z", lane: "fast", laneSource: "user-pick" },
	{ phase: "gate", edge: "start", at: "2026-09-22T14:57:31.561Z", lane: "fast", laneSource: "user-pick" },
];
// Only the final tree has these (gate:end with F14 outsideRepo, apply with diff, review end).
const SUFFIX = [
	{ phase: "gate", edge: "end", outcome: "approve", at: "2026-09-22T14:57:40.000Z", lane: "fast", laneSource: "user-pick", outsideRepo: 0, outsideRepoTmp: 0 },
	{ phase: "apply", edge: "end", outcome: "applied", at: "2026-09-22T14:59:00.000Z", lane: "fast", laneSource: "user-pick", diff: { files: 2, added: 68, deleted: 0 } },
	{ phase: "review", edge: "end", outcome: "review-written", at: "2026-09-22T15:00:00.000Z", lane: "fast", laneSource: "user-pick" },
];

function makeRunDir() {
	const runDir = mkdtempSync(join(tmpdir(), "rsb-context-"));
	const prep = join(runDir, "prep", "readyset-change", "change");
	const fin = join(runDir, "final", "readyset", "changes", "change");
	mkdirSync(prep, { recursive: true });
	mkdirSync(fin, { recursive: true });
	writeFileSync(join(prep, "CONTEXT.md"), `# Change\n${PREFIX.map(marker).join("\n")}`);
	writeFileSync(join(fin, "CONTEXT.md"), `# Change\n${[...PREFIX, ...SUFFIX].map(marker).join("\n")}`);
	return runDir;
}

test("phaseEvents merges prep + final and dedupes the shared prefix", () => {
	const runDir = makeRunDir();
	try {
		assert.equal(contextFiles(runDir).length, 2);
		const events = phaseEvents(runDir);
		assert.equal(events.length, PREFIX.length + SUFFIX.length);
		// The gate:end approval survived the merge (it only exists in the final tree).
		const gateEnd = events.find((e) => e.phase === "gate" && e.edge === "end");
		assert.equal(gateEnd?.outcome, "approve");
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("phaseSummary / outcomeCounts / mechanisms see past the gate", () => {
	const runDir = makeRunDir();
	try {
		const summary = phaseSummary(runDir);
		assert.ok(summary.hasMarkers);
		assert.equal(summary.phases.gate?.end, "2026-09-22T14:57:40.000Z");
		assert.deepStrictEqual(summary.apply, { diff: { files: 2, added: 68, deleted: 0 } });
		assert.equal(summary.review?.outcome, "review-written");
		assert.ok(summary.outcomes.apply?.includes("applied"));

		const counts = outcomeCounts(runDir);
		assert.equal(counts.approve, 1);
		assert.equal(counts.applied, 1);

		const mech = mechanismMetrics(runDir);
		assert.equal(mech.outsideRepo, 0);
		assert.equal(mech.reviewOutcome, "review-written");
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("prep-only runs still work (gate never reached)", () => {
	const runDir = mkdtempSync(join(tmpdir(), "rsb-context-prep-"));
	try {
		const prep = join(runDir, "prep", "readyset-change", "change");
		mkdirSync(prep, { recursive: true });
		writeFileSync(join(prep, "CONTEXT.md"), `# Change\n${PREFIX.map(marker).join("\n")}`);
		const summary = phaseSummary(runDir);
		assert.ok(summary.hasMarkers);
		assert.equal(summary.phases.gate?.end, null);
		assert.equal(summary.review, null);
		assert.equal(mechanismMetrics(runDir).outsideRepo, null);
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});
