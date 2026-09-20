// Single source of "now" for the whole app. Tests override it with setNow().
let override = null;

export function now() {
	return override ?? Date.now();
}

export function setNow(ms) {
	override = ms;
}

export function resetClock() {
	override = null;
}
