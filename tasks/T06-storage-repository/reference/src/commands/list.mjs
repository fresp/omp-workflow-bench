import { createTaskRepository } from "../storage/task-repository.mjs";
import { renderTable } from "../format/table.mjs";

export function run(args, io) {
	const data = createTaskRepository(io.env).load();

	let tasks = data.tasks;
	if (!args.flags.all) tasks = tasks.filter((t) => !t.done);
	if (typeof args.flags.tag === "string") {
		const tag = args.flags.tag;
		tasks = tasks.filter((t) => (t.tags ? t.tags.split(",") : []).includes(tag));
	}

	if (tasks.length === 0) {
		io.stdout.write("No tasks.\n");
		return 0;
	}
	const rows = tasks.map((t) => [String(t.id), t.done ? "x" : " ", t.title, t.due ?? "", t.tags ?? ""]);
	io.stdout.write(`${renderTable(["ID", "DONE", "TITLE", "DUE", "TAGS"], rows)}\n`);
	return 0;
}
