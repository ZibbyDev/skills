const { RateWindow } = require('./rate-window');

test('allows up to the limit', () => {
  const rw = new RateWindow(2, 1000);
  expect(rw.tryAcquire('a', 0)).toBe(true);
  expect(rw.tryAcquire('a', 1)).toBe(true);
  expect(rw.tryAcquire('a', 2)).toBe(false);
});
