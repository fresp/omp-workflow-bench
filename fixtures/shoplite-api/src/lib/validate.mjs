import { badRequest } from "./errors.mjs";

export function requireString(value, field) {
	if (typeof value !== "string" || value.trim() === "") {
		throw badRequest(`${field} must be a non-empty string`, "VALIDATION_FAILED");
	}
	return value.trim();
}

export function requireInt(value, field, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
	if (!Number.isInteger(value) || value < min || value > max) {
		throw badRequest(`${field} must be an integer between ${min} and ${max}`, "VALIDATION_FAILED");
	}
	return value;
}

export function optionalInt(value, field, opts) {
	if (value === undefined || value === null) return undefined;
	return requireInt(value, field, opts);
}
