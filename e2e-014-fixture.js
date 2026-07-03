// e2e-014 test fixture — intentionally flawed, for self-hosted code-review agent test.
function averageScore(scores) {
  let total = 0;
  // BUG: off-by-one — i <= scores.length reads undefined past the end
  for (let i = 0; i <= scores.length; i++) {
    total += scores[i];
  }
  // BUG: divide-by-zero when scores is empty → returns NaN, never guarded
  return total / scores.length;
}

function getUserName(user) {
  // BUG: no null check — throws on undefined user
  return user.profile.name.toUpperCase();
}

module.exports = { averageScore, getUserName };