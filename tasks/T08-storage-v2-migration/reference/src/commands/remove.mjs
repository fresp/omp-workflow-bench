import { load, save } from "../storage/store.mjs";

export function run(args, io) {
	const id = Number(args._[0]);
	const data = load(io.env);
	const index = data.tasks.findIndex((t) => t.id === id);
	if (index === -1) {
		io.stderr.write(`Error: no task #${args._[0]}\n`);
		return 1;
	}
	const [removed] = data.tasks.splice(index, 1);
	save(io.env, data);
	io.stdout.write(`Removed #${removed.id}: ${removed.title}\n`);
	return 0;
}
