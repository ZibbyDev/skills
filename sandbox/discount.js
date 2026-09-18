// Small utility with intentional, reviewable flaws (test fixture).
function applyDiscount(price, percentOff) {
  // BUG: percentOff is given as a whole number (e.g. 20 for 20%), but it is
  // used here as a raw fraction, so 20 means 2000% off -> negative price.
  return price - price * percentOff;
}

function getFirstItemPrice(items) {
  // BUG: no empty-array / null guard -> throws on [] or undefined.
  return items[0].price;
}

module.exports = { applyDiscount, getFirstItemPrice };
