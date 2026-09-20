// Small, dependency-free statistics helpers.

export const mean = (xs) => {
	const v = xs.filter((x) => typeof x === "number" && Number.isFinite(x));
	return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

export function median(xs) {
	const v = xs.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
	if (!v.length) return null;
	const m = Math.floor(v.length / 2);
	return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Deterministic PRNG so reports are reproducible. */
export function rng(seed = 42) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Cluster bootstrap: resample clusters (tasks) with replacement and recompute `stat` on the
 * pooled items. Returns the 95% percentile interval.
 * @param {Array<Array<any>>} clusters
 * @param {(items: any[]) => number|null} stat
 */
export function bootstrapCI(clusters, stat, { iterations = 10000, seed = 7 } = {}) {
	const valid = clusters.filter((c) => c.length);
	if (valid.length < 2) return null;
	const rand = rng(seed);
	const values = [];
	for (let i = 0; i < iterations; i++) {
		const items = [];
		for (let j = 0; j < valid.length; j++) items.push(...valid[Math.floor(rand() * valid.length)]);
		const v = stat(items);
		if (v != null && Number.isFinite(v)) values.push(v);
	}
	values.sort((a, b) => a - b);
	return values.length ? [values[Math.floor(0.025 * values.length)], values[Math.floor(0.975 * values.length)]] : null;
}

/** Exact two-sided sign test on paired differences (zeros dropped). */
export function signTest(diffs) {
	const pos = diffs.filter((d) => d > 0).length;
	const neg = diffs.filter((d) => d < 0).length;
	const n = pos + neg;
	if (n === 0) return { pos, neg, n, p: 1 };
	const k = Math.min(pos, neg);
	let tail = 0;
	for (let i = 0; i <= k; i++) tail += binom(n, i) * 0.5 ** n;
	return { pos, neg, n, p: Math.min(1, 2 * tail) };
}

function binom(n, k) {
	let r = 1;
	for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
	return r;
}

/** Cohen's kappa for two raters over the same items (categorical labels). */
export function cohensKappa(a, b) {
	const n = a.length;
	if (!n) return null;
	const labels = [...new Set([...a, ...b])];
	const po = a.filter((x, i) => x === b[i]).length / n;
	let pe = 0;
	for (const l of labels) pe += (a.filter((x) => x === l).length / n) * (b.filter((x) => x === l).length / n);
	return pe === 1 ? 1 : (po - pe) / (1 - pe);
}
