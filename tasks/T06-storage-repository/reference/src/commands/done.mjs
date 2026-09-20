import { createTaskRepository } from "../storage/task-repository.mjs";

export function run(args, io) {
	const id = Number(args._[0]);
	if (!Number.isInteger(id)) {
		io.stderr.write("Error: usage: taskflow done <id>\n");
		return 1;
	}
	const repo = createTaskRepository(io.env);
	const data = repo.load();
	const task = data.tasks.find((t) => t.id === id);
	if (!task) {
		io.stderr.write(`Error: no task #${id}\n`);
		return 1;
	}
	task.done = true;
	repo.save(data);
	io.stdout.write(`Completed #${task.id}: ${task.title}\n`);
	return 0;
}
