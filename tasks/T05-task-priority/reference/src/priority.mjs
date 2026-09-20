export const PRIORITIES = ["high", "medium", "low"];
export const DEFAULT_PRIORITY = "medium";

/** Normalise user input; returns null when invalid. */
export function parsePriority(value) {
	const p = String(value).toLowerCase();
	return PRIORITIES.includes(p) ? p : null;
}

export function invalidPriorityMessage(value) {
	return `Error: invalid --priority "${value}" (expected high, medium or low)\n`;
}

/** Tasks written before priorities existed have no field — they are medium. */
export function priorityOf(task) {
	return task.priority ?? DEFAULT_PRIORITY;
}

export function priorityRank(task) {
	return PRIORITIES.indexOf(priorityOf(task));
}
