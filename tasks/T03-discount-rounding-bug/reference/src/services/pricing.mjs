// All money maths. Amounts are integer cents — see README "Conventions".

/** Round half-up to a whole cent. Inputs here are always non-negative. */
export function roundCents(value) {
	return Math.floor(value + 0.5);
}

/**
 * Price one order line.
 * @param {{ id:number, name:string, priceCents:number, discountPercent?:number }} product
 * @param {number} quantity
 */
export function priceLine(product, quantity) {
	const pct = product.discountPercent ?? 0;
	const unitCents = product.priceCents;
	const gross = unitCents * quantity;
	// README rule: apply the percentage to the line total and round once — never per unit.
	const net = roundCents((gross * (100 - pct)) / 100);
	return {
		productId: product.id,
		name: product.name,
		quantity,
		unitPriceCents: unitCents,
		discountPercent: pct,
		grossCents: gross,
		discountCents: gross - net,
		totalCents: net,
	};
}

/** @param {ReturnType<typeof priceLine>[]} lines */
export function priceOrder(lines) {
	const subtotalCents = lines.reduce((sum, l) => sum + l.totalCents, 0);
	const discountCents = lines.reduce((sum, l) => sum + l.discountCents, 0);
	return { lines, subtotalCents, discountCents, totalCents: subtotalCents };
}
