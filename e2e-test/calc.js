'use strict';

/**
 * Utility math helpers for the e2e standard-tier review test.
 */

// REAL BUG (correctness): Array.prototype.reduce with no initial value.
// On an empty array this throws "Reduce of empty array with no initial value",
// and for a single-element array it returns that element without summing.
// Should pass an initial accumulator of 0.
function sum(numbers) {
  return numbers.reduce((acc, n) => acc + n);
}

// FALSE-POSITIVE TRAP (this is intentional and correct):
// `value == null` is a deliberate loose-equality null check that matches BOTH
// null and undefined in one comparison. This is idiomatic and intended — a
// reviewer should NOT flag it as a "use ===" bug, because == null is the
// established correct pattern for "null or undefined".
function defaulted(value, fallback) {
  if (value == null) return fallback;
  return value;
}

module.exports = { sum, defaulted };
