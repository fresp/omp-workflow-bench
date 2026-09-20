import { createTaskRepository } from "../storage/task-repository.mjs";
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
	const tags = typeof args.flags.tags === "string"
		? args.flags.tags.split(",").map((t) => t.trim()).filter(Boolean).join(",")
		: "";

	const repo = createTaskRepository(io.env);
	const data = repo.load();
	const task = { id: data.nextId, title, done: false, due, tags, createdAt: new Date().toISOString() };
	data.tasks.push(task);
	data.nextId += 1;
	repo.save(data);
	io.stdout.write(`Added #${task.id}: ${task.title}\n`);
	return 0;
}
