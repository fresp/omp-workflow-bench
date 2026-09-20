Add coupon codes.

- `POST /coupons` creates a coupon: `{ code, type, value, minSubtotalCents?, expiresAt? }` where `type`
  is `"percent"` or `"fixed"` (fixed `value` is in cents). Returns 201 with the coupon.
- `POST /orders` accepts an optional `couponCode`. The order response gets two new fields:
  `couponCode` (or `null`) and `couponDiscountCents` (0 when there is no coupon), and `totalCents`
  becomes the amount after the coupon.
- Reject bad coupons on orders with 400 and these error codes: `COUPON_INVALID` (unknown code),
  `COUPON_EXPIRED`, `COUPON_MIN_NOT_MET`.
