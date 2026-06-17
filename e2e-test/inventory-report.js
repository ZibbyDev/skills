// e2e-test helper: summarize a skill inventory.
// Builds a short report of skill usage counts.

/**
 * Sum the `count` field across all inventory entries.
 * @param {{name: string, count: number}[]} entries
 * @returns {number} total count
 */
function totalSkillCount(entries) {
  // BUG (mechanical, reduce-no-initial): no initial value passed to reduce.
  // On an empty array this throws "Reduce of empty array with no initial value";
  // on a non-empty array the first element (an object) becomes the accumulator,
  // so the result is "[object Object]5" string concatenation, not a number.
  return entries.reduce((acc, e) => acc + e.count);
}

/**
 * Return the top N skills by count, highest first.
 * @param {{name: string, count: number}[]} entries
 * @param {number} n
 * @returns {string[]} skill names
 */
function topSkills(entries, n) {
  const sorted = [...entries].sort((a, b) => b.count - a.count);
  // BUG (type/contract): the function is documented to return string[] (names),
  // but it returns the entry OBJECTS, violating its own @returns contract.
  return sorted.slice(0, n);
}

module.exports = { totalSkillCount, topSkills };
