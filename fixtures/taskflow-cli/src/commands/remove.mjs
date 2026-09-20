import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dataFile } from "../paths.mjs";

export function run(args, io) {
	const id = Number(args._[0]);
	const file = dataFile(io.env);
	const data = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { nextId: 1, tasks: [] };
	const index = data.tasks.findIndex((t) => t.id === id);
	if (index === -1) {
		io.stderr.write(`Error: no task #${args._[0]}\n`);
		return 1;
	}
	const [removed] = data.tasks.splice(index, 1);
	writeFileSync(file, JSON.stringify(data, null, 2));
	io.stdout.write(`Removed #${removed.id}: ${removed.title}\n`);
	return 0;
}
