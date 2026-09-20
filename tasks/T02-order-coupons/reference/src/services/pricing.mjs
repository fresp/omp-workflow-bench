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
	const discountedUnit = roundCents((unitCents * (100 - pct)) / 100);
	const net = discountedUnit * quantity;
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

/**
 * @param {ReturnType<typeof priceLine>[]} lines
 * @param {{ code:string, type:"percent"|"fixed", value:number } | null} [coupon] already validated
 */
export function priceOrder(lines, coupon = null) {
	const subtotalCents = lines.reduce((sum, l) => sum + l.totalCents, 0);
	const discountCents = lines.reduce((sum, l) => sum + l.discountCents, 0);
	const couponDiscountCents = coupon ? couponDiscount(coupon, subtotalCents) : 0;
	return {
		lines,
		subtotalCents,
		discountCents,
		couponCode: coupon ? coupon.code : null,
		couponDiscountCents,
		totalCents: subtotalCents - couponDiscountCents,
	};
}

/** Coupon discount on a subtotal: percent rounded once half-up, never more than the subtotal. */
export function couponDiscount(coupon, subtotalCents) {
	const raw = coupon.type === "percent" ? roundCents((subtotalCents * coupon.value) / 100) : coupon.value;
	return Math.min(raw, subtotalCents);
}
