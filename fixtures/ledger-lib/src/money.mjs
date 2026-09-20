/** "12.34" → 1234, "-0.5" → -50, "7" → 700. Throws on anything else. */
export function parseAmount(text) {
	const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(String(text).trim());
	if (!m) throw new Error(`invalid amount: ${JSON.stringify(text)}`);
	const cents = Number(m[2]) * 100 + Number((m[3] ?? "0").padEnd(2, "0"));
	return m[1] ? -cents : cents;
}

/** 1234 → "12.34", -50 → "-0.50" */
export function formatAmount(cents) {
	const sign = cents < 0 ? "-" : "";
	const abs = Math.abs(cents);
	return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
