import { load, save, parseTags } from "../storage/store.mjs";
import { isValidDate } from "../dates.mjs";

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
	const tags = typeof args.flags.tags === "string" ? parseTags(args.flags.tags) : [];

	const data = load(io.env);
	const task = { id: data.nextId, title, done: false, due, tags, createdAt: new Date().toISOString() };
	data.tasks.push(task);
	data.nextId += 1;
	save(io.env, data);
	io.stdout.write(`Added #${task.id}: ${task.title}\n`);
	return 0;
}
