import { badRequest, conflict } from "../lib/errors.mjs";
import { requireInt, requireString, optionalInt } from "../lib/validate.mjs";
import { now } from "../lib/clock.mjs";

export function register(router, { store }) {
	router.post("/coupons", async (ctx) => {
		const body = ctx.body ?? {};
		const code = requireString(body.code, "code").toUpperCase();
		if (body.type !== "percent" && body.type !== "fixed") {
			throw badRequest("type must be percent or fixed", "VALIDATION_FAILED");
		}
		const value = requireInt(body.value, "value", { min: 1, max: body.type === "percent" ? 100 : Number.MAX_SAFE_INTEGER });
		const minSubtotalCents = optionalInt(body.minSubtotalCents, "minSubtotalCents", { min: 0 }) ?? null;
		let expiresAt = null;
		if (body.expiresAt !== undefined && body.expiresAt !== null) {
			if (typeof body.expiresAt !== "string" || Number.isNaN(Date.parse(body.expiresAt))) {
				throw badRequest("expiresAt must be an ISO timestamp", "VALIDATION_FAILED");
			}
			expiresAt = body.expiresAt;
		}
		if (store.getCoupon(code)) throw conflict(`Coupon ${code} already exists`);
		ctx.status = 201;
		ctx.result = store.addCoupon({ code, type: body.type, value, minSubtotalCents, expiresAt });
	});
}

/** Look up and validate a coupon for an order with the given subtotal (after sale discounts). */
export function resolveCoupon(store, code, subtotalCents) {
	const coupon = typeof code === "string" ? store.getCoupon(code.trim()) : null;
	if (!coupon) throw badRequest(`Coupon ${code} is not valid`, "COUPON_INVALID");
	if (coupon.expiresAt && now() > Date.parse(coupon.expiresAt)) {
		throw badRequest(`Coupon ${coupon.code} has expired`, "COUPON_EXPIRED");
	}
	if (coupon.minSubtotalCents !== null && subtotalCents < coupon.minSubtotalCents) {
		throw badRequest(`Coupon ${coupon.code} needs a subtotal of at least ${coupon.minSubtotalCents}`, "COUPON_MIN_NOT_MET");
	}
	return coupon;
}
