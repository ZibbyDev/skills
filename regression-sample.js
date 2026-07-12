// Throwaway sample for exercising the github-code-review agent (regression).
// Contains a couple of deliberate small issues for the reviewer to catch.

function pickFirstMatch(items, predicate) {
  // BUG: no guard for items being null/undefined -> throws on .length
  for (let i = 0; i <= items.length; i++) {   // BUG: off-by-one (<=) reads items[length] === undefined
    if (predicate(items[i])) return items[i];
  }
  return null;
}

module.exports = { pickFirstMatch };
