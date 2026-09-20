import { existsSync, readFileSync } from "node:fs";
import { dataFile } from "../paths.mjs";
import { renderTable } from "../format/table.mjs";
import { invalidPriorityMessage, parsePriority, priorityOf, priorityRank } from "../priority.mjs";

export function run(args, io) {
	const file = dataFile(io.env);
	const data = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { nextId: 1, tasks: [] };

	let wanted = null;
	if (args.flags.priority !== undefined) {
		wanted = parsePriority(args.flags.priority);
		if (!wanted) {
			io.stderr.write(invalidPriorityMessage(args.flags.priority));
			return 1;
		}
	}

	let tasks = data.tasks;
	if (wanted) tasks = tasks.filter((t) => priorityOf(t) === wanted);
	if (!args.flags.all) tasks = tasks.filter((t) => !t.done);
	if (typeof args.flags.tag === "string") {
		const tag = args.flags.tag;
		tasks = tasks.filter((t) => (t.tags ? t.tags.split(",") : []).includes(tag));
	}

	if (tasks.length === 0) {
		io.stdout.write("No tasks.\n");
		return 0;
	}
	tasks = [...tasks].sort((a, b) => priorityRank(a) - priorityRank(b) || a.id - b.id);
	const rows = tasks.map((t) => [String(t.id), t.done ? "x" : " ", t.title, priorityOf(t), t.due ?? "", t.tags ?? ""]);
	io.stdout.write(`${renderTable(["ID", "DONE", "TITLE", "PRIORITY", "DUE", "TAGS"], rows)}\n`);
	return 0;
}
