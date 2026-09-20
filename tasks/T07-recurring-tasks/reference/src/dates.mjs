// Dates are calendar dates as "YYYY-MM-DD" strings. No time zones involved.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDate(value) {
	const m = DATE_RE.exec(value ?? "");
	if (!m) return false;
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	if (mo < 1 || mo > 12 || d < 1) return false;
	return d <= daysInMonth(y, mo);
}

export function daysInMonth(year, month) {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function parseDate(value) {
	const [y, m, d] = value.split("-").map(Number);
	return { year: y, month: m, day: d };
}

export function formatDate({ year, month, day }) {
	return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export const RECURRENCES = ["day", "week", "month"];

/** Next due date for a recurrence, computed from the previous due date. Months clamp to the last day. */
export function nextDue(due, every) {
	const { year, month, day } = parseDate(due);
	if (every === "day" || every === "week") {
		const d = new Date(Date.UTC(year, month - 1, day + (every === "day" ? 1 : 7)));
		return formatDate({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
	}
	if (every === "month") {
		const nextMonth = month === 12 ? 1 : month + 1;
		const nextYear = month === 12 ? year + 1 : year;
		return formatDate({ year: nextYear, month: nextMonth, day: Math.min(day, daysInMonth(nextYear, nextMonth)) });
	}
	throw new Error(`unknown recurrence: ${every}`);
}
