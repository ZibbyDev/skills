// Tiny fixture for Codex code-review e2e. Intentionally contains a reviewable flaw.
function applyDiscount(price, percent) {
  // BUG: no validation — negative/over-100 percent or non-numeric price slips through,
  // and the result is never rounded, leaking floating-point cents.
  return price - price * percent / 100;
}

function totalForCart(items) {
  // BUG: uses == instead of ===, and mutates the caller's array via sort().
  let total = 0;
  for (var i = 0; i <= items.length; i++) {   // BUG: off-by-one (<=) → undefined access
    total += applyDiscount(items[i].price, items[i].discount);
  }
  return total;
}

module.exports = { applyDiscount, totalForCart };
