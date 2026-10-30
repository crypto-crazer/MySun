// Per-client page rate caps of the demo worker (TASK-QUOTA-GUARDS). Plain `node --test`, no deps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, RETRY_AFTER_SEC, WINDOW_MS, checkLimit, clientKey, createLimiterState } from '../ratelimit.js';

/** Send `n` requests at `nowMs`; returns how many were admitted. */
function burst(state, ip, n, nowMs) {
  let ok = 0;
  for (let i = 0; i < n; i++) if (checkLimit(state, ip, nowMs).allowed) ok++;
  return ok;
}

test('IPv4 keys by the address; IPv6 by its /64 prefix', () => {
  assert.equal(clientKey('203.0.113.7'), '203.0.113.7');
  assert.equal(clientKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(clientKey('2001:0DB8:0001:0002:ffff:eeee:dddd:cccc'), '2001:db8:1:2::/64');
  assert.equal(clientKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(clientKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(clientKey(null), 'unknown');
  assert.notEqual(clientKey('2001:db8:1:2::1'), clientKey('2001:db8:1:3::1'));
});

test('two addresses in one IPv6 /64 share one budget; two IPv4 addresses do not', () => {
  const state = createLimiterState();
  assert.equal(burst(state, '2001:db8:1:2::a', LIMITS.page / 2, 0), LIMITS.page / 2);
  assert.equal(burst(state, '2001:db8:1:2:dead:beef:0:1', LIMITS.page, 0), LIMITS.page / 2);
  assert.equal(burst(state, '2001:db8:1:3::a', 1, 0), 1, 'another /64 has its own budget');

  assert.equal(burst(state, '203.0.113.7', LIMITS.page, 0), LIMITS.page);
  assert.equal(burst(state, '203.0.113.7', 1, 0), 0);
  assert.equal(burst(state, '203.0.113.8', 1, 0), 1);
});

test('pages/assets are capped at 180 per minute', () => {
  const state = createLimiterState();
  assert.equal(LIMITS.page, 180);
  assert.equal(burst(state, '198.51.100.2', 100, 0), 100);
  assert.equal(burst(state, '198.51.100.2', 100, 10_000), 80);
  assert.deepEqual(checkLimit(state, '198.51.100.2', 20_000), { allowed: false, retryAfterSec: RETRY_AFTER_SEC });
  assert.equal(RETRY_AFTER_SEC, 30);
});

test('the limiter has only the page bucket — no /rpc or failed-proxy budget is left', () => {
  assert.deepEqual(Object.keys(LIMITS), ['page']);
});

test('the window slides: capacity returns as old requests age past 60s, not all at once', () => {
  const state = createLimiterState();
  const ip = '198.51.100.3';
  // 90 pages at t=0s, 90 at t=30s → full.
  assert.equal(burst(state, ip, 90, 0), 90);
  assert.equal(burst(state, ip, 90, 30_000), 90);
  assert.equal(burst(state, ip, 1, 59_999), 0);
  // At t=60s the first 90 expire (a fixed window would also reset the t=30s ones).
  assert.equal(burst(state, ip, 180, 60_000), 90);
  assert.equal(burst(state, ip, 1, 89_999), 0);
  assert.equal(burst(state, ip, 180, 90_000), 90);
});

test('refused requests are not counted: a looping client still gets exactly the cap through', () => {
  const state = createLimiterState();
  const ip = '198.51.100.4';
  // 16 req/s for 2 minutes (the observed loop) → at most 180 per sliding minute admitted.
  let admitted = 0;
  for (let t = 0; t < 2 * WINDOW_MS; t += 1_000 / 16) if (checkLimit(state, ip, t).allowed) admitted++;
  assert.equal(admitted, 2 * LIMITS.page);
});

test('a human-paced client under the cap always passes', () => {
  const state = createLimiterState();
  const ip = '2001:db8:aa:bb::1';
  // 2 req/s for 10 minutes.
  for (let t = 0, n = 0; t < 10 * WINDOW_MS; t += 500, n++) {
    assert.equal(checkLimit(state, ip, t).allowed, true, `request ${n} at ${t}ms`);
  }
});
