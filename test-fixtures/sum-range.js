// Returns the sum of all integers from `start` to `end`, INCLUSIVE.
// e.g. sumRange(1, 5) should be 1+2+3+4+5 = 15.
function sumRange(start, end) {
  let total = 0;
  for (let i = start; i < end; i++) {
    total += i;
  }
  return total;
}

module.exports = { sumRange };
