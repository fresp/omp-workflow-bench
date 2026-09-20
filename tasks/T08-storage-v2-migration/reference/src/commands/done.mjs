import { load, save } from "../storage/store.mjs";

export function run(args, io) {
	const id = Number(args._[0]);
	if (!Number.isInteger(id)) {
		io.stderr.write("Error: usage: taskflow done <id>\n");
		return 1;
	}
	const data = load(io.env);
	const task = data.tasks.find((t) => t.id === id);
	if (!task) {
		io.stderr.write(`Error: no task #${id}\n`);
		return 1;
	}
	task.done = true;
	save(io.env, data);
	io.stdout.write(`Completed #${task.id}: ${task.title}\n`);
	return 0;
}
