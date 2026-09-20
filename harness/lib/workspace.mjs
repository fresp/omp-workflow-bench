// Create a throwaway git workspace from a fixture: identical bytes and identical base commit every time.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export function git(cwd, args, { allowFail = false } = {}) {
	const res = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "bench",
			GIT_AUTHOR_EMAIL: "bench@localhost",
			GIT_COMMITTER_NAME: "bench",
			GIT_COMMITTER_EMAIL: "bench@localhost",
			GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
			GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
		},
	});
	if (res.status !== 0 && !allowFail) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${res.stderr}`);
	return res.stdout ?? "";
}

/** Copy fixture → dest, init a repo, commit as "base". Returns the base commit sha. */
export function makeWorkspace(fixtureDir, dest) {
	if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
	mkdirSync(dirname(dest), { recursive: true });
	cpSync(fixtureDir, dest, { recursive: true, filter: (src) => !src.includes("node_modules") });
	git(dest, ["init", "-q", "-b", "main"]);
	git(dest, ["add", "-A"]);
	git(dest, ["commit", "-q", "-m", "base"]);
	return git(dest, ["rev-parse", "HEAD"]).trim();
}
