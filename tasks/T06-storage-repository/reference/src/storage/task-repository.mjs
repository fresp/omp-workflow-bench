import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { dataFile } from "../paths.mjs";

export class StorageError extends Error {}

/** Single owner of tasks.json. Writes are atomic (temp file in the same directory + rename). */
export function createTaskRepository(env) {
	const file = dataFile(env);
	return {
		file,
		load() {
			if (!existsSync(file)) return { nextId: 1, tasks: [] };
			try {
				return JSON.parse(readFileSync(file, "utf8"));
			} catch (err) {
				throw new StorageError(`could not read ${file}: ${err.message}`);
			}
		},
		save(data) {
			mkdirSync(dirname(file), { recursive: true });
			const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
			writeFileSync(tmp, JSON.stringify(data, null, 2));
			renameSync(tmp, file);
		},
	};
}
