import { homedir } from "node:os";
import { join } from "node:path";

export function dataDir(env) {
	return env.TASKFLOW_HOME ?? join(homedir(), ".taskflow");
}

export function dataFile(env) {
	return join(dataDir(env), "tasks.json");
}
