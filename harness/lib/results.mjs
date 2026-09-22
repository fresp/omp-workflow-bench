import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./config.mjs";

export const RESULTS = join(ROOT, "results");

/** `--label x` or the label of the most recent run. */
export function resolveLabel(label) {
	if (label) return label;
	const latest = join(RESULTS, "LATEST");
	if (existsSync(latest)) return readFileSync(latest, "utf8").trim();
	throw new Error("no --label given and results/LATEST does not exist — run ./run.sh first");
}

export function setLatest(label) {
	mkdirSync(RESULTS, { recursive: true });
	writeFileSync(join(RESULTS, "LATEST"), `${label}\n`);
}

/** Every run directory (one per task × arm × model × rep) under a label. */
export function listRunDirs(label) {
	const base = join(RESULTS, label);
	if (!existsSync(base)) return [];
	const out = [];
	for (const taskDir of readdirSync(base).filter((d) => /^T\d+/.test(d) && statSync(join(base, d)).isDirectory()).sort()) {
		for (const cell of readdirSync(join(base, taskDir)).sort()) {
			const dir = join(base, taskDir, cell);
			if (!statSync(dir).isDirectory() || !/__r\d+$/.test(cell)) continue;
			const m = /^(plan|readyset(?:-(?:fast|full|auto))?)__(.+)__r(\d+)$/.exec(cell);
			if (!m) continue;
			// `arm` stays the family ("plan"/"readyset") so every existing comparison keeps working;
			// the lane lives in `lane` and the exact directory arm name in `armRaw`. A bare
			// "readyset" is the historical alias for readyset-fast.
			const lane = m[1] === "plan" ? null : m[1] === "readyset" ? "fast" : m[1].replace(/^readyset-/, "");
			out.push({ dir, taskDir, cell, arm: m[1] === "plan" ? "plan" : "readyset", armRaw: m[1], lane, modelSlug: m[2], rep: Number(m[3]) });
		}
	}
	return out;
}

export function readJson(file, fallback = null) {
	return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback;
}

export function readText(file, fallback = "") {
	return existsSync(file) ? readFileSync(file, "utf8") : fallback;
}

/** Recursively list files under dir (relative paths, sorted). */
export function walk(dir, rel = "") {
	if (!existsSync(dir)) return [];
	return readdirSync(join(dir, rel))
		.sort()
		.flatMap((name) => {
			const r = rel ? `${rel}/${name}` : name;
			return statSync(join(dir, r)).isDirectory() ? walk(dir, r) : [r];
		});
}
