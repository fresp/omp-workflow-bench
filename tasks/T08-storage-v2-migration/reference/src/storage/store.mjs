import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataFile } from "../paths.mjs";

export const SCHEMA_VERSION = 2;

export class StorageError extends Error {}

/** v1 comma string → v2 array (trimmed, empties dropped). */
export function parseTags(value) {
	if (Array.isArray(value)) return value;
	if (typeof value !== "string") return [];
	return value.split(",").map((t) => t.trim()).filter(Boolean);
}

export function migrateV1(data) {
	return { schemaVersion: SCHEMA_VERSION, nextId: data.nextId, tasks: data.tasks.map((t) => ({ ...t, tags: parseTags(t.tags) })) };
}

/** Load tasks.json, migrating a v1 file in place (with a byte-exact backup) when needed. */
export function load(env) {
	const file = dataFile(env);
	if (!existsSync(file)) return { schemaVersion: SCHEMA_VERSION, nextId: 1, tasks: [] };
	const raw = readFileSync(file, "utf8");
	const data = JSON.parse(raw);
	const version = data.schemaVersion ?? 1;
	if (version > SCHEMA_VERSION) {
		throw new StorageError(`${file} was written by a newer version of taskflow (schemaVersion ${version})`);
	}
	if (version === 1) {
		const backup = join(dirname(file), "tasks.v1.bak.json");
		if (!existsSync(backup)) copyFileSync(file, backup);
		const migrated = migrateV1(data);
		save(env, migrated);
		return migrated;
	}
	return data;
}

export function save(env, data) {
	const file = dataFile(env);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify({ ...data, schemaVersion: SCHEMA_VERSION }, null, 2));
}
