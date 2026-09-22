// Stage a minimal, neutral-named copy of the extension under test.
//
// Why: the run sandbox used to read-only-bind the *whole* extension repository, which let a run read
// the extension's own source (`src/extensions/readyset-review.ts`, `src/lib/*`) and learn the
// benchmark's vocabulary. omp loads the extension from exactly `src/extensions/`, `src/lib/` and
// `src/skill/` — nothing else is needed at load time — so we copy just those three trees into the
// run's output dir (which is not mounted into the sandbox) and load from there. The staged root has
// a neutral leaf name (`ext`), so no path under it contains "readyset".
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** The extension repo directory (`<repo>/src/extensions/x.ts` → `<repo>`). */
function extensionRoot(extPath) {
	return resolve(dirname(extPath), "..", "..");
}

/** The three trees omp needs to load the extension; everything else is not read at load time. */
const STAGED_SUBDIRS = ["src/extensions", "src/lib", "src/skill"];

/**
 * Copy the minimal extension into `destDir` and return the staged entry file to pass to `-e`.
 * Idempotent: an existing `destDir` is removed first, so a re-run never sees stale files.
 * Throws (naming the path) when the source entry is missing; a copy failure propagates.
 * @param {string} extPath the real extension entry (`…/src/extensions/<name>.ts`)
 * @param {string} destDir the staging root (e.g. `<run output>/ext`)
 * @returns {string} the staged entry path, `join(destDir, "src", "extensions", <basename>)`
 */
export function stageExtension(extPath, destDir) {
	if (!existsSync(extPath)) throw new Error(`stageExtension: extension entry not found: ${extPath}`);
	const root = extensionRoot(extPath);
	for (const sub of STAGED_SUBDIRS) {
		const from = join(root, sub);
		if (!existsSync(from)) throw new Error(`stageExtension: expected source tree missing: ${from}`);
	}
	if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
	mkdirSync(destDir, { recursive: true });
	for (const sub of STAGED_SUBDIRS) cpSync(join(root, sub), join(destDir, sub), { recursive: true });
	const staged = join(destDir, "src", "extensions", basename(extPath));
	if (!existsSync(staged)) throw new Error(`stageExtension: staged entry not written: ${staged}`);
	return staged;
}
