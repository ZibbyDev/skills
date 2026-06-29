// Utility for summing a numeric range. Added for github-code-review e2e test.

// Returns the sum of all integers from `start` to `end` inclusive.
function sumRange(start, end) {
  var total = 0;
  for (var i = start; i <= end; i++) {
    total = total + i;
  }
  return total;
}

// Returns the average of an array of numbers.
function average(nums) {
  var sum = 0;
  for (var j = 0; j < nums.length; j++) {
    sum += nums[j];
  }
  return sum / nums.length;
}

module.exports = { sumRange, average };
