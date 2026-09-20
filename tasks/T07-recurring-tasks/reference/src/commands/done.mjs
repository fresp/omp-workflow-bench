import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dataFile } from "../paths.mjs";
import { nextDue } from "../dates.mjs";

export function run(args, io) {
	const id = Number(args._[0]);
	if (!Number.isInteger(id)) {
		io.stderr.write("Error: usage: taskflow done <id>\n");
		return 1;
	}
	const file = dataFile(io.env);
	if (!existsSync(file)) {
		io.stderr.write(`Error: no task #${id}\n`);
		return 1;
	}
	const data = JSON.parse(readFileSync(file, "utf8"));
	const task = data.tasks.find((t) => t.id === id);
	if (!task) {
		io.stderr.write(`Error: no task #${id}\n`);
		return 1;
	}
	const wasDone = task.done;
	task.done = true;
	let next = null;
	if (task.every && task.due && !wasDone) {
		next = { id: data.nextId, title: task.title, done: false, due: nextDue(task.due, task.every), tags: task.tags, every: task.every, createdAt: new Date().toISOString() };
		data.tasks.push(next);
		data.nextId += 1;
	}
	writeFileSync(file, JSON.stringify(data, null, 2));
	io.stdout.write(`Completed #${task.id}: ${task.title}\n`);
	if (next) io.stdout.write(`Next: #${next.id} due ${next.due}\n`);
	return 0;
}
