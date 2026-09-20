# Persona — support lead who filed the bug

Facts you know (answer only what you are asked):

- Finance follows the pricing rule written in the README: the percentage discount is applied to the line total (unit price × quantity) and rounded once, half-up.
- The "Travel Grinder" is just an example product; the fix should apply to every product.
- Already-placed orders do not need to be recalculated; only new orders matter.
- Please add a regression test.
- `discountCents` on lines and on the order must stay consistent with the corrected totals (gross minus net).
