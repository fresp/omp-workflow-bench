import { createTaskRepository } from "../storage/task-repository.mjs";

export function run(args, io) {
	const id = Number(args._[0]);
	const repo = createTaskRepository(io.env);
	const data = repo.load();
	const index = data.tasks.findIndex((t) => t.id === id);
	if (index === -1) {
		io.stderr.write(`Error: no task #${args._[0]}\n`);
		return 1;
	}
	const [removed] = data.tasks.splice(index, 1);
	repo.save(data);
	io.stdout.write(`Removed #${removed.id}: ${removed.title}\n`);
	return 0;
}
