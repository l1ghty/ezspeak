const test = require('node:test');
const assert = require('node:assert/strict');
const { ipKey, clientIp, lastHop, originAllowed, createWindowLimiter, DECEPTIVE_CHARS } = require('../../server/security');

test('ipKey normalizes IPv4-mapped and groups IPv6 by /64', () => {
  assert.equal(ipKey('1.2.3.4'), '1.2.3.4');
  assert.equal(ipKey('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(ipKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(ipKey('2001:db8:1:2:bbbb:cccc:dddd:eeee'), '2001:db8:1:2::/64', 'same /64 → same key');
  assert.equal(ipKey('2001:0db8:0001:0002::'), '2001:db8:1:2::/64');
  assert.equal(ipKey('::1'), '0:0:0:0::/64');
  assert.equal(ipKey('garbage'), 'unknown');
  assert.equal(ipKey(undefined), 'unknown');
});

test('clientIp trusts only the configured number of proxy hops (rightmost)', () => {
  const req = (xff, remote = '10.0.0.9') => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: remote } });
  assert.equal(clientIp(req('6.6.6.6'), 0), '10.0.0.9', 'no proxy → header ignored');
  // Client spoofs "6.6.6.6", the proxy appends the real address.
  assert.equal(clientIp(req('6.6.6.6, 203.0.113.5'), 1), '203.0.113.5');
  assert.equal(clientIp(req('6.6.6.6, 203.0.113.5, 10.1.1.1'), 2), '203.0.113.5');
  assert.equal(clientIp(req(null), 1), '10.0.0.9');
  assert.equal(lastHop('evil.example, real.example', 1), 'real.example');
  assert.equal(lastHop('', 1), null);
});

test('originAllowed: own origin, configured origins, no-origin clients', () => {
  assert.equal(originAllowed('https://voice.example', 'voice.example'), true);
  assert.equal(originAllowed('http://localhost:3111', 'localhost:3111'), true);
  assert.equal(originAllowed('https://evil.example', 'voice.example'), false);
  assert.equal(originAllowed('https://voice.example.evil.com', 'voice.example'), false);
  assert.equal(originAllowed('null', 'voice.example'), false);
  assert.equal(originAllowed(undefined, 'voice.example'), true, 'non-browser client');
  assert.equal(originAllowed('https://app.example', 'voice.example', ['https://app.example/']), true);
  assert.equal(originAllowed('https://x.example', 'voice.example', ['*']), true);
});

test('window limiter', () => {
  let t = 0;
  const l = createWindowLimiter({ limit: 2, windowMs: 1000, now: () => t });
  assert.equal(l.hit('a'), true);
  assert.equal(l.blocked('a'), false);
  assert.equal(l.hit('a'), true);
  assert.equal(l.blocked('a'), true);
  assert.equal(l.hit('a'), false);
  assert.equal(l.hit('b'), true, 'keys are independent');
  assert.equal(l.retryAfterMs('a'), 1000);
  t = 1000;
  assert.equal(l.blocked('a'), false);
  assert.equal(l.hit('a'), true);
});

test('DECEPTIVE_CHARS', () => {
  assert.ok(DECEPTIVE_CHARS.test('a‮b'));
  assert.ok(DECEPTIVE_CHARS.test('a﻿b'));
  assert.ok(!DECEPTIVE_CHARS.test('normal name'));
});
