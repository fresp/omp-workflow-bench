#!/usr/bin/env node
// Human calibration of the LLM judges (do this before publishing numbers).
//   export: samples N (task, model, rep) pairs, writes blind A/B review sheets + a sealed key
//   score:  compares your verdicts with the judges' combined verdicts (agreement + Cohen's kappa)
// Usage:
//   node harness/calibrate.mjs export [--label L] [--n 12]
//   (fill in results/<label>/calibration/verdicts.json)
//   node harness/calibrate.mjs score  [--label L]
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { listTasks } from "./lib/config.mjs";
import { listRunDirs, readJson, readText, resolveLabel, RESULTS } from "./lib/results.mjs";
import { cohensKappa, rng } from "./lib/stats.mjs";

const { values: argv, positionals } = parseArgs({ allowPositionals: true, options: { label: { type: "string" }, n: { type: "string", default: "12" } } });
const label = resolveLabel(argv.label);
const dir = join(RESULTS, label, "calibration");
const tasks = Object.fromEntries(listTasks().map((t) => [t.dirName, t]));

if (positionals[0] === "export") {
	const pairs = new Map();
	for (const r of listRunDirs(label).filter((r) => existsSync(join(r.dir, "compiled.json")))) {
		const k = `${r.taskDir}|${r.modelSlug}|${r.rep}`;
		if (!pairs.has(k)) pairs.set(k, {});
		pairs.get(k)[r.arm] = r;
	}
	const complete = [...pairs.entries()].filter(([, p]) => p.plan && p.readyset);
	const rand = rng(2026);
	complete.sort(() => rand() - 0.5);
	const chosen = complete.slice(0, Number(argv.n));
	mkdirSync(dir, { recursive: true });
	const key = {};
	const template = {};
	chosen.forEach(([k, p], i) => {
		const id = `pair-${String(i + 1).padStart(2, "0")}`;
		const flip = rand() < 0.5;
		const [a, b] = flip ? [p.readyset, p.plan] : [p.plan, p.readyset];
		key[id] = { pair: k, A: a.arm, B: b.arm };
		template[id] = { plan: "A|B|tie", code: "A|B|tie", note: "" };
		const task = tasks[p.plan.taskDir];
		writeFileSync(
			join(dir, `${id}.md`),
			`# ${id} — ${task.id} ${task.title}\n\n## Request\n\n${task.request}\n\n## What the user actually wanted\n\n${task.acceptance}\n\n` +
				`---\n\n# Planning document A\n\n${readText(join(a.dir, "judge", "plan.md")) || "_(empty)_"}\n\n---\n\n# Planning document B\n\n${readText(join(b.dir, "judge", "plan.md")) || "_(empty)_"}\n\n` +
				`---\n\n# Code A\n\n\`\`\`diff\n${readText(join(a.dir, "judge", "code.diff"))}\n\`\`\`\n\n# Code B\n\n\`\`\`diff\n${readText(join(b.dir, "judge", "code.diff"))}\n\`\`\`\n`,
		);
	});
	writeFileSync(join(dir, "key.sealed.json"), `${JSON.stringify(key, null, 2)}\n`);
	if (!existsSync(join(dir, "verdicts.json"))) writeFileSync(join(dir, "verdicts.json"), `${JSON.stringify(template, null, 2)}\n`);
	console.log(`${chosen.length} blind pairs → results/${label}/calibration/ — review pair-XX.md, fill verdicts.json (don't open key.sealed.json), then run: calibrate.mjs score`);
} else if (positionals[0] === "score") {
	const key = readJson(join(dir, "key.sealed.json"));
	const verdicts = readJson(join(dir, "verdicts.json"));
	const judgments = [];
	const jdir = join(RESULTS, label, "judgments");
	for (const t of readdirSync(jdir).filter((d) => statSync(join(jdir, d)).isDirectory())) for (const f of readdirSync(join(jdir, t)).filter((f) => f.endsWith(".json"))) judgments.push(readJson(join(jdir, t, f)));
	for (const kind of ["plan", "code"]) {
		const human = [];
		const judge = [];
		for (const [id, v] of Object.entries(verdicts)) {
			const h = v[kind];
			if (!["A", "B", "tie"].includes(h)) continue;
			const k = key[id];
			const [taskDir, slug, rep] = k.pair.split("|");
			const js = judgments.filter((j) => j.kind === kind && j.taskDir === taskDir && j.modelSlug === slug && String(j.rep) === rep && j.byArm);
			if (!js.length) continue;
			// Pooled judge verdict: majority over all judge × order votes on "overall".
			const votes = js.map((j) => j.byArm.overall);
			const count = (a) => votes.filter((x) => x === a).length;
			const pooled = count("readyset") > count("plan") ? "readyset" : count("plan") > count("readyset") ? "plan" : "tie";
			human.push(h === "tie" ? "tie" : k[h]);
			judge.push(pooled);
		}
		const agree = human.filter((h, i) => h === judge[i]).length;
		console.log(`${kind}: ${human.length} pairs, agreement ${human.length ? ((agree / human.length) * 100).toFixed(0) : "—"}%, Cohen's kappa ${human.length ? cohensKappa(human, judge).toFixed(2) : "—"}`);
	}
	console.log("rule of thumb: kappa ≥ 0.6 → judges usable for the published numbers; below that, fix the rubric first.");
} else {
	console.log("usage: calibrate.mjs export|score [--label L] [--n 12]");
}
