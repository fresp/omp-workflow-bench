# Persona — product owner of shoplite-api

You asked for coupon codes. Facts you know (answer only what you are asked):

- Coupon codes are case-insensitive: "summer10", "SUMMER10" and "Summer10" are the same coupon. Store and return them upper-cased.
- Creating a coupon whose code already exists (case-insensitively) → 409 with code `CONFLICT`.
- Validation on create: `type` must be percent|fixed, `value` a positive integer, percent value at most 100; failures → 400 `VALIDATION_FAILED`.
- The coupon applies to the order subtotal AFTER product sale discounts (i.e. to `subtotalCents`).
- Percent coupons: discount = subtotal × percent / 100, rounded once, half-up, to whole cents (same rule as the README pricing rule).
- Fixed coupons can never make the total negative: the discount is capped at the subtotal (total floors at 0).
- `minSubtotalCents` is compared against the subtotal after sale discounts; subtotal must be >= min.
- `expiresAt` is an ISO timestamp; the coupon is expired when the current time (via the app clock) is strictly after it. Expiry is checked at order time.
- Only one coupon per order; no usage limits for now.
- `discountCents` on the order keeps meaning "product sale discounts" only; do not add the coupon into it.
- Please document the new endpoint and fields in the README.
