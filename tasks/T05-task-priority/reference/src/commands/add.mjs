import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { dataFile } from "../paths.mjs";
import { isValidDate } from "../dates.mjs";
import { DEFAULT_PRIORITY, invalidPriorityMessage, parsePriority } from "../priority.mjs";

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
	let priority = DEFAULT_PRIORITY;
	if (args.flags.priority !== undefined) {
		priority = parsePriority(args.flags.priority);
		if (!priority) {
			io.stderr.write(invalidPriorityMessage(args.flags.priority));
			return 1;
		}
	}
	const tags = typeof args.flags.tags === "string"
		? args.flags.tags.split(",").map((t) => t.trim()).filter(Boolean).join(",")
		: "";

	const file = dataFile(io.env);
	let data = { nextId: 1, tasks: [] };
	if (existsSync(file)) data = JSON.parse(readFileSync(file, "utf8"));

	const task = { id: data.nextId, title, done: false, due, tags, priority, createdAt: new Date().toISOString() };
	data.tasks.push(task);
	data.nextId += 1;

	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(data, null, 2));
	io.stdout.write(`Added #${task.id}: ${task.title}\n`);
	return 0;
}
