import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { dataFile } from "../paths.mjs";
import { isValidDate, RECURRENCES } from "../dates.mjs";

export function run(args, io) {
	const title = args._.join(" ").trim();
	if (!title) {
		io.stderr.write("Error: a title is required\n");
		return 1;
	}
	const due = args.flags.due ?? null;
	if (due !== null && !isValidDate(due)) {
		io.stderr.write(`Error: invalid --due date "${due}" (expected YYYY-MM-DD)\n`);
		return 1;
	}
	let every = null;
	if (args.flags.every !== undefined) {
		every = String(args.flags.every);
		if (!RECURRENCES.includes(every)) {
			io.stderr.write(`Error: invalid --every "${every}" (expected day, week or month)\n`);
			return 1;
		}
		if (due === null) {
			io.stderr.write("Error: --every needs a --due date\n");
			return 1;
		}
	}
	const tags = typeof args.flags.tags === "string"
		? args.flags.tags.split(",").map((t) => t.trim()).filter(Boolean).join(",")
		: "";

	const file = dataFile(io.env);
	let data = { nextId: 1, tasks: [] };
	if (existsSync(file)) data = JSON.parse(readFileSync(file, "utf8"));

	const task = { id: data.nextId, title, done: false, due, tags, createdAt: new Date().toISOString() };
	if (every) task.every = every;
	data.tasks.push(task);
	data.nextId += 1;

	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(data, null, 2));
	io.stdout.write(`Added #${task.id}: ${task.title}\n`);
	return 0;
}
