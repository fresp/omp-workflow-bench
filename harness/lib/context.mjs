// Parse readyset's own `CONTEXT.md` phase events and change-dir artefacts.
//
// readyset ≥ 0.13 writes `<!-- readyset-phase -->` JSON fences into a change's CONTEXT.md, one per
// phase transition: {phase, edge: "start"|"end", at, lane, laneSource, outcome, …}. Earlier
// versions (and v0.12) write only the change's headings, so every accessor here tolerates absence
// and returns null — callers render "—".
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The change dir for a run: the gate snapshot first, else the final tree. */
export function changeDirs(runDir) {
	const out = [];
	for (const base of [join(runDir, "prep", "readyset-change"), join(runDir, "final", "readyset", "changes")]) {
		if (!existsSync(base)) continue;
		for (const id of readdirSync(base)) {
			if (id === "archive") {
				const arch = join(base, id);
				if (existsSync(arch)) for (const a of readdirSync(arch)) out.push(join(arch, a));
			} else out.push(join(base, id));
		}
	}
	return out;
}

/** Every change dir's CONTEXT.md that exists, in changeDirs() order (gate snapshot first). */
export function contextFiles(runDir) {
	const out = [];
	for (const d of changeDirs(runDir)) {
		const f = join(d, "CONTEXT.md");
		if (existsSync(f)) out.push(f);
	}
	return out;
}

/** The first change dir's CONTEXT.md, or null. Kept for callers that only need one file. */
export function contextFile(runDir) {
	for (const d of changeDirs(runDir)) {
		const f = join(d, "CONTEXT.md");
		if (existsSync(f)) return f;
	}
	return null;
}

/** Stable stringify for event dedup: key order must not matter, exact duplicates must collapse. */
function stableKey(v) {
	if (Array.isArray(v)) return `[${v.map(stableKey).join(",")}]`;
	if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableKey(v[k])}`).join(",")}}`;
	return JSON.stringify(v);
}

/**
 * Every `<!-- readyset-phase -->` event across all CONTEXT.md files, in file order.
 *
 * The gate snapshot (`prep/readyset-change/`) is a prefix of the final tree
 * (`final/readyset/changes/`): qc-sanity2's prep file holds 7 markers (grill → gate:start)
 * while the final file holds those same 7 plus 12 more (gate:end, apply, review, …).
 * Reading only the first file truncates phaseSummary/outcomeCounts/mechanisms at the gate.
 * Exact duplicates (same JSON) collapse; near-duplicates (e.g. repeated apply starts with
 * different timestamps) are preserved.
 */
export function phaseEvents(runDir) {
	const seen = new Set();
	const out = [];
	for (const d of changeDirs(runDir)) {
		const f = join(d, "CONTEXT.md");
		if (!existsSync(f)) continue;
		let text;
		try {
			text = readFileSync(f, "utf8");
		} catch {
			continue;
		}
		for (const m of text.matchAll(/<!--\s*readyset-phase\s*-->\s*```json\s*([\s\S]*?)```/g)) {
			try {
				const ev = JSON.parse(m[1]);
				const key = stableKey(ev);
				if (seen.has(key)) continue;
				seen.add(key);
				out.push(ev);
			} catch {}
		}
	}
	return out;
}

/**
 * Fold phase events into a run summary:
 *   {lane, laneSource, phases: {name: {start, end, ms}}, outcomes: {…}, review: {ran, skipped,
 *    triggersFired, triggersEvaluated, outcome}, apply: {diff}, hasMarkers}
 * Absent fields are null; `hasMarkers` is false for pre-0.13 runs.
 */
export function phaseSummary(runDir) {
	const events = phaseEvents(runDir);
	const summary = { hasMarkers: events.length > 0, lane: null, laneSource: null, phases: {}, outcomes: {}, review: null, apply: null };
	if (!events.length) return summary;
	const open = new Map();
	for (const ev of events) {
		const name = String(ev.phase ?? "").toLowerCase();
		if (!name) continue;
		if (ev.lane) summary.lane = String(ev.lane).toLowerCase();
		if (ev.laneSource) summary.laneSource = ev.laneSource;
		const bucket = (summary.phases[name] ??= { start: null, end: null, ms: null });
		if (ev.edge === "start" && ev.at) {
			bucket.start = ev.at;
			open.set(name, ev.at);
		}
		if (ev.edge === "end") {
			bucket.end = ev.at ?? null;
			const s = open.get(name);
			if (s && ev.at) bucket.ms = Date.parse(ev.at) - Date.parse(s);
			if (ev.outcome) summary.outcomes[name] = (summary.outcomes[name] ?? []).concat(ev.outcome);
		}
		// Review details ride on the review event.
		if (name === "review") {
			summary.review ??= { ran: true, skipped: false, triggersEvaluated: 0, triggersFired: [], outcome: null };
			if (Array.isArray(ev.triggersEvaluated)) summary.review.triggersEvaluated = ev.triggersEvaluated.length;
			if (Array.isArray(ev.triggersFired)) summary.review.triggersFired = ev.triggersFired;
			if (ev.outcome === "skipped" || ev.skipped) {
				summary.review.ran = false;
				summary.review.skipped = true;
			}
			if (ev.outcome) summary.review.outcome = ev.outcome;
		}
		if (name === "apply" && ev.edge === "end" && ev.diff) summary.apply = { diff: ev.diff };
	}
	return summary;
}

/** Count occurrences of each outcome name across all phases, e.g. {contract-repair: 2}. */
export function outcomeCounts(runDir) {
	const events = phaseEvents(runDir);
	const counts = {};
	for (const ev of events) {
		const o = ev.outcome;
		if (!o || ev.edge !== "end") continue;
		counts[o] = (counts[o] ?? 0) + 1;
	}
	return counts;
}

/**
 * readyset-flow F1–F7 mechanism measurements, parsed from the change dir + CONTEXT.md phase events.
 * Every field tolerates absence (older runs) and is null rather than 0 when not measurable.
 */
export function mechanismMetrics(runDir) {
	const dirs = changeDirs(runDir);
	const events = phaseEvents(runDir);
	const readAll = (name) => {
		for (const d of dirs) {
			const f = join(d, name);
			if (existsSync(f)) {
				try {
					return readFileSync(f, "utf8");
				} catch {}
			}
		}
		return null;
	};

	// F1: open decisions at the gate, assumptions, assumed scenarios — from the brainstorm and the
	// proposal. The grill writes `## Open decisions`, proposals mark assumptions.
	const brainstormText = `${readAll("proposal.md") ?? ""}\n${readAll("design.md") ?? ""}`;
	const openDecisions = countSection(brainstormText, /open\s+decisions?/i);
	const assumptions = (brainstormText.match(/\bassumption\b/gi) ?? []).length;
	const assumedScenarios = (brainstormText.match(/\(assumed\)/gi) ?? []).length;

	// F2/F3: blocking findings and how many were fixed.
	const reviewText = readAll("REVIEW.md") ?? "";
	const blocking = countSection(reviewText, /blocking/i);
	const reviewOutcome = events.findLast?.((e) => String(e.phase).toLowerCase() === "review" && e.edge === "end")?.outcome ?? null;
	const reviewFix = events.findLast?.((e) => String(e.phase).toLowerCase() === "review-fix" && e.edge === "end")?.outcome ?? null;

	// F5: requested docs missing from the contract, and whether contract repair resolved them.
	const contractWarnings = events.filter((e) => /requested doc missing from contract/i.test(String(e.outcome ?? e.message ?? ""))).length;
	const contractRepair = events.findLast?.((e) => String(e.phase).toLowerCase() === "contract-repair" && e.edge === "end")?.outcome ?? null;

	// readyset's own accounting of paths it saw outside the repo, on the gate `end` event
	// (readyset ≥ F14). Pre-F14 runs write no such field → null, rendered "—".
	const gateEnd = events.findLast?.((e) => String(e.phase).toLowerCase() === "gate" && e.edge === "end") ?? null;
	const numOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
	const outsideRepo = numOrNull(gateEnd?.outsideRepo);
	const outsideRepoTmp = numOrNull(gateEnd?.outsideRepoTmp);

	// F6: scope reconciliation counts.
	const scopeEvents = events.filter((e) => String(e.phase).toLowerCase() === "scope-reconcile");
	const scopeReconcile = {
		reverted: scopeEvents.filter((e) => e.outcome === "reverted").length,
		justified: scopeEvents.filter((e) => e.outcome === "justified").length,
		unjustified: scopeEvents.filter((e) => e.outcome === "unjustified").length,
		outOfListReverted: events.filter((e) => /out-of-list revert detected/i.test(String(e.message ?? ""))).length,
		outOfListRestored: events.filter((e) => /out-of-list revert restored/i.test(String(e.message ?? ""))).length,
	};

	// Internal-terms advisory hits from the change text (validateChange's own vocabulary).
	const internalTerms = ["readyset", "grill", "brainstorm", "lane", "contract", "apply", "review gate"].reduce((n, t) => n + (readAll("tasks.md") ?? "").toLowerCase().split(t).length - 1, 0);

	const hasAnything = dirs.length > 0 || events.length > 0;
	return {
		measurable: hasAnything,
		openDecisions,
		assumptions,
		assumedScenarios,
		blockingFindings: blocking,
		reviewOutcome,
		reviewFix,
		contractWarnings,
		contractRepair,
		outsideRepo,
		outsideRepoTmp,
		scopeReconcile,
		internalTerms,
	};
}

/** Count the non-empty lines of a `## <heading>` section, or 0 if the heading is absent. */
function countSection(text, headingRe) {
	if (!text) return 0;
	const lines = text.split("\n");
	let i = 0;
	for (; i < lines.length; i++) {
		const m = /^#{1,6}\s+(.*)$/.exec(lines[i]);
		if (m && headingRe.test(m[1])) break;
	}
	if (i >= lines.length) return 0;
	let n = 0;
	for (let j = i + 1; j < lines.length; j++) {
		if (/^#{1,6}\s+/.test(lines[j])) break;
		const t = lines[j].trim();
		if (!t || /^[-*]\s*none\b/i.test(t)) continue;
		if (/^[-*]\s/.test(t) || /^\d+\./.test(t)) n++;
	}
	return n;
}

