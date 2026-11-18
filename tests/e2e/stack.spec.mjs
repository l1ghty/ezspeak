// Runs against the real docker compose stack (ezspeak + coturn), started by
// `npm run test:stack`. Verifies that voice really flows through the TURN
// relay when direct connections are not allowed. Skipped otherwise.
import { test, expect } from '@playwright/test';

const STACK = process.env.E2E_STACK_URL;
test.skip(!STACK, 'set E2E_STACK_URL (use `npm run test:stack`)');

const uniq = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function openUser(browser, path, name, init) {
  const context = await browser.newContext({ baseURL: STACK, permissions: ['microphone'] });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  await page.goto(path);
  await expect(page.locator('#status-dot.connected')).toBeVisible({ timeout: 15000 });
  return { context, page };
}

const rtc = (page) => page.evaluate(() => getRtcDebugInfo());

async function expectRelayedAudio(page, { timeout = 30000 } = {}) {
  await expect.poll(async () => {
    const peers = Object.values(await rtc(page));
    return peers.length > 0 && peers.every((p) =>
      p.state === 'connected' && p.localCandidateType === 'relay' && p.bytesReceived > 3000);
  }, { timeout, intervals: [500, 1000] }).toBe(true);
}

test('stack serves the app and hands out TURN credentials for the page host', async ({ browser }) => {
  const a = await openUser(browser, `/server/${uniq('stack')}?username=alice`, 'alice');
  const ice = await a.page.evaluate(() => serverState.iceServers);
  const turn = ice.find((s) => [].concat(s.urls).some((u) => u.startsWith('turn:')));
  expect(turn, JSON.stringify(ice)).toBeTruthy();
  const host = new URL(STACK).hostname;
  expect([].concat(turn.urls).every((u) => u.startsWith(`turn:${host}:`))).toBe(true);
  expect(turn.username).toMatch(/^\d+:\d+$/);
  expect(turn.credential).toBeTruthy();
  expect(await a.page.evaluate(() => serverState.relayAvailable)).toBe(true);
  await a.context.close();
});

test('relay room: voice flows through coturn in both directions', async ({ browser }) => {
  const room = uniq('relayroom');
  const a = await openUser(browser, `/server/${room}?relay=1&username=alice`, 'alice');
  expect(await a.page.evaluate(() => serverState.relayOnly)).toBe(true);
  const b = await openUser(browser, `/server/${room}?username=bob`, 'bob');
  await expectRelayedAudio(a.page);
  await expectRelayedAudio(b.page);
  // Nobody learns anybody's real address: only relay candidates were exchanged.
  for (const p of [a.page, b.page]) {
    for (const info of Object.values(await rtc(p))) {
      expect(info.remoteCandidateType).toBe('relay');
      const cands = (info.remoteSdp || '').split(/\r?\n/).filter((l) => l.startsWith('a=candidate'));
      expect(cands.every((l) => / typ relay /.test(l))).toBe(true);
    }
  }
  await a.context.close(); await b.context.close();
});

test('firewalled peers fall back to the relay automatically (no warning needed)', async ({ browser }) => {
  // Drop every non-relay candidate: direct paths can never work, a relayed one can.
  const firewall = () => {
    const P = RTCPeerConnection.prototype;
    const add = P.addIceCandidate;
    P.addIceCandidate = function (c) {
      return c && c.candidate && !/ typ relay /.test(c.candidate) ? Promise.resolve() : add.call(this, c);
    };
  };
  const room = uniq('fw');
  const a = await openUser(browser, `/server/${room}?username=alice`, 'alice', firewall);
  const b = await openUser(browser, `/server/${room}?username=bob`, 'bob', firewall);
  await expectRelayedAudio(a.page);
  await expectRelayedAudio(b.page);
  await expect(a.page.locator('#network-warning-modal')).toBeHidden();
  await a.context.close(); await b.context.close();
});
