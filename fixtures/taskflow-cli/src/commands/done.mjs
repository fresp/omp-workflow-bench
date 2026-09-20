import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dataFile } from "../paths.mjs";

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
	task.done = true;
	writeFileSync(file, JSON.stringify(data, null, 2));
	io.stdout.write(`Completed #${task.id}: ${task.title}\n`);
	return 0;
}
