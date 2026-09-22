import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function loadConfig() {
	const cfg = JSON.parse(readFileSync(join(ROOT, "bench.config.json"), "utf8"));
	cfg.limits ??= {};
	cfg.limits.runMinutes ??= 45;
	cfg.limits.idleSeconds ??= 25;
	cfg.limits.maxSimUserAnswers ??= 14;
	cfg.limits.maxNudges ??= 3;
	cfg.omp ??= {};
	cfg.omp.bin ??= "omp";
	cfg.omp.extraArgs ??= [];
	// Overrides used by the offline smoke test (harness/test/smoke.sh).
	if (process.env.BENCH_OMP_BIN) cfg.omp.bin = process.env.BENCH_OMP_BIN;
	if (process.env.BENCH_READYSET_EXT) cfg.omp.readysetExtension = process.env.BENCH_READYSET_EXT;
	if (process.env.BENCH_WORK_DIR) cfg.workDir = process.env.BENCH_WORK_DIR;
	if (process.env.BENCH_IDLE_SECONDS) cfg.limits.idleSeconds = Number(process.env.BENCH_IDLE_SECONDS);
	// Test-only override for the offline smoke test, e.g.
	// BENCH_QUICKCHECK_JSON='{"userEditsPreserved": true}'. The real criterion lives in
	// bench.config.json → quickCheck.
	if (process.env.BENCH_QUICKCHECK_JSON) {
		try {
			cfg.quickCheck = { ...(cfg.quickCheck ?? {}), ...JSON.parse(process.env.BENCH_QUICKCHECK_JSON) };
		} catch {
			throw new Error("BENCH_QUICKCHECK_JSON is not valid JSON");
		}
	}
	return cfg;
}

export function loadModels() {
	const file = join(ROOT, "models.txt");
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.map((l) => l.replace(/#.*/, "").trim())
		.filter(Boolean);
}

export function modelSlug(model) {
	return model.replace(/^@/, "at-").replace(/[^A-Za-z0-9._-]+/g, "_");
}

export function listTasks(filter = []) {
	const dir = join(ROOT, "tasks");
	return readdirSync(dir)
		.filter((d) => /^T\d+/.test(d))
		.filter((d) => filter.length === 0 || filter.some((f) => d.startsWith(f)))
		.sort()
		.map((d) => loadTask(d));
}

export function loadTask(dirName) {
	const dir = join(ROOT, "tasks", dirName);
	const meta = JSON.parse(readFileSync(join(dir, "task.json"), "utf8"));
	return {
		...meta,
		dirName,
		dir,
		request: readFileSync(join(dir, "request.md"), "utf8").trim(),
		persona: readFileSync(join(dir, "persona.md"), "utf8").trim(),
		acceptance: readFileSync(join(dir, "acceptance.md"), "utf8").trim(),
		fixtureDir: join(ROOT, "fixtures", meta.fixture),
	};
}

/**
 * The handful of omp settings that decide which model an arm uses when `@config` is selected.
 * A tiny indentation-aware reader — only the keys we need, no YAML dependency.
 */
export function readOmpModelConfig(path = join(homedir(), ".omp/agent/config.yml")) {
	if (!existsSync(path)) return { path, found: false };
	const lines = readFileSync(path, "utf8").split("\n");
	const stack = [];
	const values = {};
	for (const raw of lines) {
		if (/^\s*(#|$)/.test(raw)) continue;
		const m = /^(\s*)([A-Za-z0-9_.-]+):\s*(.*?)\s*(#.*)?$/.exec(raw);
		if (!m) continue;
		const indent = m[1].length;
		while (stack.length && stack.at(-1).indent >= indent) stack.pop();
		const key = [...stack.map((s) => s.key), m[2]].join(".");
		if (m[3] === "") stack.push({ indent, key: m[2] });
		else values[key] = m[3].replace(/^["']|["']$/g, "");
	}
	return {
		path,
		found: true,
		planModel: values["modelRoles.plan"],
		defaultModel: values["modelRoles.default"],
		readysetModel: values["readyset.model.default"] ?? values["readyset.model"] ?? values["modelRoles.default"],
		readysetLanguage: values["readyset.language"],
	};
}

/** Which model plans and which executes, for one arm. */
export function resolveArmModels(arm, model) {
	if (model !== "@config") return { planModel: model, execModel: model, source: "models.txt" };
	const omp = readOmpModelConfig();
	if (!omp.found) throw new Error(`@config needs ${omp.path}`);
	if (arm === "plan") return { planModel: omp.planModel ?? omp.defaultModel, execModel: omp.defaultModel, source: "config: modelRoles.plan → modelRoles.default" };
	return { planModel: omp.readysetModel, execModel: omp.readysetModel, source: "config: readyset.model.default (pinned for every turn)" };
}
