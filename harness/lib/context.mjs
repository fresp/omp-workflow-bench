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

/** The first change dir's CONTEXT.md, or null. */
export function contextFile(runDir) {
	for (const d of changeDirs(runDir)) {
		const f = join(d, "CONTEXT.md");
		if (existsSync(f)) return f;
	}
	return null;
}

/** Every `<!-- readyset-phase -->` event in a CONTEXT.md, in file order. */
export function phaseEvents(runDir) {
	const f = contextFile(runDir);
	if (!f) return [];
	let text;
	try {
		text = readFileSync(f, "utf8");
	} catch {
		return [];
	}
	const out = [];
	for (const m of text.matchAll(/<!--\s*readyset-phase\s*-->\s*```json\s*([\s\S]*?)```/g)) {
		try {
			out.push(JSON.parse(m[1]));
		} catch {}
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
