import { parseArgs } from "./args.mjs";
import { StorageError } from "./storage/task-repository.mjs";
import * as add from "./commands/add.mjs";
import * as list from "./commands/list.mjs";
import * as done from "./commands/done.mjs";
import * as remove from "./commands/remove.mjs";

const commands = { add, list, done, remove };

const USAGE = `Usage: taskflow <command> [options]

Commands:
  add <title> [--due YYYY-MM-DD] [--tags a,b]
  list [--all] [--tag <tag>]
  done <id>
  remove <id>`;

export async function run(argv, io) {
	const args = parseArgs(argv);
	const [name, ...rest] = args._;
	if (!name || args.flags.help) {
		io.stdout.write(`${USAGE}\n`);
		return name ? 0 : 1;
	}
	const command = commands[name];
	if (!command) {
		io.stderr.write(`Error: unknown command "${name}"\n${USAGE}\n`);
		return 1;
	}
	try {
		return await command.run({ _: rest, flags: args.flags }, io);
	} catch (err) {
		if (err instanceof StorageError) {
			io.stderr.write(`Error: ${err.message}\n`);
			return 1;
		}
		throw err;
	}
}
