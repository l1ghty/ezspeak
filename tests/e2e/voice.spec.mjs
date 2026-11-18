// End-to-end voice tests: real Chromium peers with fake microphones talking
// over WebRTC through the real signaling server.
import { test, expect } from '@playwright/test';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { loadConfig } = require('../../server/config.js');
const { createApp } = require('../../server/app.js');

const uniq = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function openUser(browser, baseURL, room, name, { init } = {}) {
  const context = await browser.newContext({ baseURL, permissions: ['microphone', 'camera'] });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] pageerror:`, e.message));
  await page.goto(`/server/${room}?username=${encodeURIComponent(name)}`);
  await expect(page.locator('#status-dot.connected')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#user-list .user-item', { hasText: name })).toBeVisible({ timeout: 10000 });
  return { context, page, name };
}

const myId = (page) => page.evaluate(() => userId);
const rtc = (page) => page.evaluate(() => getRtcDebugInfo());

// Wait until `page` has a connected link to every id in `peerIds` with
// audio bytes flowing in.
async function expectAudioFrom(page, peerIds, { minBytes = 3000, timeout = 20000 } = {}) {
  await expect.poll(async () => {
    const info = await rtc(page);
    return peerIds.every((id) => info[id] && info[id].state === 'connected' && info[id].bytesReceived > minBytes);
  }, { timeout, intervals: [250, 500, 1000] }).toBe(true);
}

async function bytesFrom(page, peerId) {
  return (await rtc(page))[peerId]?.bytesReceived || 0;
}

test.describe('voice (P2P mesh)', () => {
  test('two users hear each other', async ({ browser, baseURL }) => {
    const room = uniq('duo');
    const a = await openUser(browser, baseURL, room, 'alice');
    const b = await openUser(browser, baseURL, room, 'bob');
    const [ida, idb] = [await myId(a.page), await myId(b.page)];

    await expectAudioFrom(a.page, [idb]);
    await expectAudioFrom(b.page, [ida]);
    await expect(a.page.locator('.user-indicator.connected')).toHaveCount(2);

    await a.context.close(); await b.context.close();
  });

  test('three users form a full mesh', async ({ browser, baseURL }) => {
    const room = uniq('trio');
    const users = [];
    for (const n of ['u1', 'u2', 'u3']) users.push(await openUser(browser, baseURL, room, n));
    const ids = await Promise.all(users.map((u) => myId(u.page)));
    for (let i = 0; i < users.length; i++) {
      await expectAudioFrom(users[i].page, ids.filter((_, j) => j !== i));
    }
    for (const u of users) await u.context.close();
  });

  test('switching channels tears down and rebuilds links', async ({ browser, baseURL }) => {
    const room = uniq('switch');
    const a = await openUser(browser, baseURL, room, 'alice');
    const b = await openUser(browser, baseURL, room, 'bob');
    const [ida, idb] = [await myId(a.page), await myId(b.page)];
    await expectAudioFrom(a.page, [idb]);

    await b.page.locator('.channel-item', { hasText: 'Channel 1' }).click();
    await expect(b.page.locator('#current-channel-title')).toContainText('Channel 1');
    await expect.poll(async () => Object.keys(await rtc(a.page)).length).toBe(0);
    await expect.poll(async () => Object.keys(await rtc(b.page)).length).toBe(0);

    await a.page.locator('.channel-item', { hasText: 'Channel 1' }).click();
    await expectAudioFrom(a.page, [idb]);
    await expectAudioFrom(b.page, [ida]);
    await a.context.close(); await b.context.close();
  });

  test('voice survives a signaling drop and the session is resumed', async ({ browser, baseURL }) => {
    const room = uniq('drop');
    const a = await openUser(browser, baseURL, room, 'alice');
    const b = await openUser(browser, baseURL, room, 'bob');
    const [ida, idb] = [await myId(a.page), await myId(b.page)];
    await expectAudioFrom(a.page, [idb]);
    const connIdBefore = (await rtc(a.page))[idb].connId;

    // Kill B's WebSocket (simulates a network blip / mobile background).
    await b.page.evaluate(() => ws.close());
    await expect(b.page.locator('#status-dot.connected')).toBeVisible({ timeout: 10000 });

    expect(await myId(b.page)).toBe(idb);            // same session resumed
    const before = await bytesFrom(a.page, idb);
    await expect.poll(() => bytesFrom(a.page, idb), { timeout: 5000 }).toBeGreaterThan(before + 2000);
    expect((await rtc(a.page))[idb].connId).toBe(connIdBefore);  // media path untouched

    // Signaling still works after resume (regression test): chat round-trip.
    await b.page.locator('#chat-input').fill('still here');
    await b.page.locator('#chat-input').press('Enter');
    await expect(a.page.locator('#chat-messages')).toContainText('still here');
    await a.context.close(); await b.context.close();
  });

  test('a reloaded peer gets a fresh connection', async ({ browser, baseURL }) => {
    const room = uniq('reload');
    const a = await openUser(browser, baseURL, room, 'alice');
    const b = await openUser(browser, baseURL, room, 'bob');
    const idb = await myId(b.page);
    await expectAudioFrom(a.page, [idb]);

    await b.page.reload();
    await expect(b.page.locator('#status-dot.connected')).toBeVisible({ timeout: 10000 });
    const idb2 = await myId(b.page);
    await expectAudioFrom(a.page, [idb2]);
    await expectAudioFrom(b.page, [await myId(a.page)]);
    // The stale link to the old session is gone.
    if (idb2 !== idb) await expect.poll(async () => !!(await rtc(a.page))[idb]).toBe(false);
    await a.context.close(); await b.context.close();
  });

  test('a broken peer connection is rebuilt automatically', async ({ browser, baseURL }) => {
    const room = uniq('heal');
    const a = await openUser(browser, baseURL, room, 'alice');
    const b = await openUser(browser, baseURL, room, 'bob');
    const idb = await myId(b.page);
    await expectAudioFrom(a.page, [idb]);
    const oldConn = (await rtc(a.page))[idb].connId;

    // Brutally close A's side of the link; the watchdog must notice.
    await a.page.evaluate((id) => peerConnections.get(id).close(), idb);
    await expect.poll(async () => {
      const i = (await rtc(a.page))[idb];
      return !!i && i.connId !== oldConn && i.state === 'connected' && i.bytesReceived > 2000;
    }, { timeout: 25000, intervals: [500, 1000] }).toBe(true);
    await a.context.close(); await b.context.close();
  });

  test('per-user volume and mute survive re-rendering', async ({ browser, baseURL }) => {
    const room = uniq('vol');
    const a = await openUser(browser, baseURL, room, 'alice');
    const b = await openUser(browser, baseURL, room, 'bob');
    const idb = await myId(b.page);
    await expectAudioFrom(a.page, [idb]);

    await a.page.locator(`.vol-slider[data-peer="${idb}"]`).fill('30');
    await a.page.locator(`.peer-mute-btn[data-peer="${idb}"]`).click();
    const audio = await a.page.evaluate((id) => {
      const el = remoteAudios.get(id);
      return { muted: el.muted, volume: el.volume };
    }, idb);
    expect(audio.muted).toBe(true);
    expect(audio.volume).toBeCloseTo(Math.pow(0.3, 1.5), 3);

    // Mute/deafen state is broadcast to the other side
    await b.page.locator('#mute-btn').click();
    await expect(a.page.locator('.user-status-icon.muted')).toBeVisible();
    await a.context.close(); await b.context.close();
  });

  test('channel capacity is enforced in the UI without dropping the call', async ({ browser, baseURL }) => {
    const room = uniq('cap');
    const a = await openUser(browser, baseURL, room, 'alice');
    // alice is the creator → lower the per-channel limit to 2
    await a.page.locator('#set-pw-btn-header').click();
    await a.page.locator('#max-channel-users-input').fill('2');
    await a.page.locator('#set-pw-form button[type="submit"]').click();
    await expect(a.page.locator('.channel-item', { hasText: 'Lobby' }).locator('.channel-count')).toHaveText('1/2');

    const b = await openUser(browser, baseURL, room, 'bob');
    const ida = await myId(a.page);
    await expectAudioFrom(a.page, [await myId(b.page)]);

    // carol's default channel (Lobby) is full → she lands in the next one
    const c = await openUser(browser, baseURL, room, 'carol');
    await expect(c.page.locator('#current-channel-title')).toContainText('Channel 1');

    // Explicitly trying to enter the full Lobby is refused and keeps her call state
    await c.page.locator('.channel-item', { hasText: 'Lobby' }).click();
    await expect(c.page.locator('#confirm-modal-message')).toContainText('full');
    await expect(c.page.locator('#current-channel-title')).toContainText('Channel 1');
    // …and alice/bob were not disturbed
    const before = await bytesFrom(b.page, ida);
    await expect.poll(() => bytesFrom(b.page, ida), { timeout: 5000 }).toBeGreaterThan(before + 1000);
    for (const u of [a, b, c]) await u.context.close();
  });
});

test.describe('privacy (relay-only)', () => {
  let relayServer;
  let relayBase;

  test.beforeAll(async () => {
    // A second instance with a TURN server configured that does not exist:
    // connections can't succeed, but we can verify nothing leaks.
    const config = loadConfig({
      PORT: '0', STUN_URLS: '', MAX_CONNECTIONS_PER_IP: '200', MAX_SERVERS_PER_IP: '200',
      TURN_URLS: 'turn:127.0.0.1:9', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p',
    });
    relayServer = createApp(config, { log: { log() {}, warn() {}, error() {} } });
    const port = await relayServer.listen(0);
    relayBase = `http://127.0.0.1:${port}`;
  });

  test.afterAll(async () => { await relayServer?.close(); });

  test('relay-only server never reveals any peer address', async ({ browser }) => {
    const room = uniq('priv');
    const a = await openUser(browser, relayBase, room, 'alice');
    await a.page.locator('#set-pw-btn-header').click();
    await expect(a.page.locator('#relay-only-check')).toBeEnabled();
    await a.page.locator('#relay-only-check').check();
    await a.page.locator('#set-pw-form button[type="submit"]').click();
    await expect(a.page.locator('#privacy-badge')).toBeVisible();

    // Record every signaling message B receives.
    const b = await openUser(browser, relayBase, room, 'bob');
    await expect(b.page.locator('#privacy-badge')).toBeVisible();
    await b.page.evaluate(() => {
      window.__signals = [];
      ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        if (m.type?.startsWith('webrtc-')) window.__signals.push(m);
      });
    });
    // Rejoin the channel so fresh negotiation happens while recording.
    await b.page.locator('.channel-item', { hasText: 'Channel 1' }).click();
    await a.page.locator('.channel-item', { hasText: 'Channel 1' }).click();
    await expect.poll(() => b.page.evaluate(() => window.__signals.length), { timeout: 10000 }).toBeGreaterThan(0);
    await b.page.waitForTimeout(2500);  // let ICE gathering finish

    const signals = await b.page.evaluate(() => window.__signals);
    const ipRe = /\b(?!0\.0\.0\.0\b)\d{1,3}(\.\d{1,3}){3}\b/;
    for (const m of signals) {
      if (m.candidate) {
        expect(m.candidate.candidate).toMatch(/typ relay/);
        expect(m.candidate.candidate).not.toMatch(/raddr (?!0\.0\.0\.0)/);
      }
      const sdp = (m.offer || m.answer)?.sdp;
      if (sdp) {
        const leaky = sdp.split(/\r?\n/).filter((l) =>
          (l.startsWith('a=candidate') && !/typ relay/.test(l)) ||
          (l.startsWith('c=') && ipRe.test(l) && !/127\.0\.0\.1/.test(l)));
        expect(leaky).toEqual([]);
        expect(sdp).not.toMatch(/\.local\b/);
      }
    }
    // Local policy is relay-only on both sides.
    const infoB = await rtc(b.page);
    for (const v of Object.values(infoB)) expect(v.relayOnly).toBe(true);
    await a.context.close(); await b.context.close();
  });

  test('personal relay-only without TURN refuses to connect directly', async ({ browser, baseURL }) => {
    const room = uniq('noturn');
    const a = await openUser(browser, baseURL, room, 'alice');
    await a.page.evaluate(() => localStorage.setItem(LS_RELAY_ONLY, '1'));
    await a.page.reload();
    await expect(a.page.locator('#status-dot.connected')).toBeVisible({ timeout: 10000 });
    await expect(a.page.locator('#privacy-badge')).toContainText('Relay unavailable');

    const b = await openUser(browser, baseURL, room, 'bob');
    await b.page.waitForTimeout(3000);
    // alice never builds a connection (so never sends a candidate)…
    expect(Object.keys(await rtc(a.page))).toEqual([]);
    // …and bob can't reach her directly.
    const infoB = await rtc(b.page);
    expect(Object.values(infoB).filter((i) => i.state === 'connected')).toEqual([]);
    await expect(a.page.locator('#chat-messages')).toContainText('no TURN relay');
    await a.context.close(); await b.context.close();
  });
});

// ── Network blocked warnings ────────────────────────────────────────────────

// Simulates a firewall that blocks all direct WebRTC traffic: no ICE
// candidate ever reaches the browser, so links can never connect.
const blockIce = () => {
  const P = RTCPeerConnection.prototype;
  P.addIceCandidate = function () { return Promise.resolve(); };
  const srd = P.setRemoteDescription;
  P.setRemoteDescription = function (d) {
    if (d && d.sdp) d = { type: d.type, sdp: d.sdp.split(/\r?\n/).filter((l) => !l.startsWith('a=candidate')).join('\r\n') };
    return srd.call(this, d);
  };
};

// Simulates a proxy that kills WebSocket connections.
const blockWebSocket = () => {
  class BlockedSocket extends EventTarget {
    constructor() {
      super();
      this.readyState = 0;
      setTimeout(() => { this.readyState = 3; this.onclose && this.onclose({ code: 1006 }); }, 30);
    }
    send() {}
    close() {}
  }
  Object.assign(BlockedSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = BlockedSocket;
};

const fastTimings = (page) => page.evaluate(() => Object.assign(rtcTiming, { connectTimeout: 2500, watchdogInterval: 500 }));

test.describe('network blocked warnings', () => {
  let relayServer;
  let relayBase;

  test.beforeAll(async () => {
    const config = loadConfig({
      PORT: '0', STUN_URLS: '', MAX_CONNECTIONS_PER_IP: '200', MAX_SERVERS_PER_IP: '200',
      TURN_URLS: 'turn:127.0.0.1:9', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p',
    });
    relayServer = createApp(config, { log: { log() {}, warn() {}, error() {} } });
    relayBase = `http://127.0.0.1:${await relayServer.listen(0)}`;
  });
  test.afterAll(async () => { await relayServer?.close(); });

  test('blocked direct connection offers a relay room, which gets created', async ({ browser }) => {
    const room = uniq('fw');
    const a = await openUser(browser, relayBase, room, 'alice', { init: blockIce });
    await fastTimings(a.page);
    const b = await openUser(browser, relayBase, room, 'bob', { init: blockIce });
    await fastTimings(b.page);

    const dialog = a.page.locator('#network-warning-modal');
    await expect(dialog).toBeVisible({ timeout: 15000 });
    await expect(dialog).toContainText('Connection blocked');
    await expect(dialog).toContainText('bob');
    await expect(a.page.locator('#network-warning-relay-room')).toBeVisible();
    await expect(a.page.locator('#network-warning-relay-me')).toBeVisible();
    if (process.env.E2E_SCREENSHOTS) await a.page.screenshot({ path: process.env.E2E_SCREENSHOTS + '/p2p-blocked.png' });

    await a.page.locator('#network-warning-relay-room').click();
    await a.page.waitForURL(new RegExp(`/server/${room}-relay-[a-z0-9]{4}$`));
    await expect(a.page.locator('#status-dot.connected')).toBeVisible();
    await expect(a.page.locator('#share-modal')).toBeVisible();           // share the new link
    await expect(a.page.locator('#chat-messages')).toContainText('Relay room created');
    const st = await a.page.evaluate(() => ({ relayOnly: serverState.relayOnly, creator: serverState.creator === userId }));
    expect(st).toEqual({ relayOnly: true, creator: true });
    await expect(a.page.locator('#privacy-badge')).toBeVisible();
    // The share link has no internal flags
    expect(await a.page.locator('#share-url-input').inputValue()).not.toContain('relay=1');

    // bob left behind in the old room was told alice left
    await expect(b.page.locator('#user-list')).not.toContainText('alice');
    await a.context.close(); await b.context.close();
  });

  test('"use relay just for me" switches this user to relay mode', async ({ browser }) => {
    const room = uniq('fwme');
    const a = await openUser(browser, relayBase, room, 'alice', { init: blockIce });
    await fastTimings(a.page);
    const b = await openUser(browser, relayBase, room, 'bob', { init: blockIce });
    await fastTimings(b.page);
    await expect(a.page.locator('#network-warning-modal')).toBeVisible({ timeout: 15000 });
    await a.page.locator('#network-warning-relay-me').click();
    await expect(a.page.locator('#network-warning-modal')).toBeHidden();
    await expect(a.page.locator('#privacy-badge')).toBeVisible();
    expect(await a.page.evaluate(() => localStorage.getItem(LS_RELAY_ONLY))).toBe('1');
    await expect.poll(async () => Object.values(await rtc(a.page)).every((i) => i.relayOnly)).toBe(true);
    await a.context.close(); await b.context.close();
  });

  test('without a TURN relay the dialog explains instead of offering a relay room', async ({ browser, baseURL }) => {
    const room = uniq('fwnoturn');
    const a = await openUser(browser, baseURL, room, 'alice', { init: blockIce });
    await fastTimings(a.page);
    const b = await openUser(browser, baseURL, room, 'bob', { init: blockIce });
    await fastTimings(b.page);
    const dialog = a.page.locator('#network-warning-modal');
    await expect(dialog).toBeVisible({ timeout: 15000 });
    await expect(dialog).toContainText('no relay (TURN) server');
    await expect(a.page.locator('#network-warning-relay-room')).toBeHidden();
    await a.page.locator('#network-warning-dismiss').click();
    await expect(dialog).toBeHidden();
    // Not shown again right away (cool-down)
    await a.page.waitForTimeout(4000);
    await expect(dialog).toBeHidden();
    await a.context.close(); await b.context.close();
  });

  test('when even the relay fails, the dialog says so and offers no relay room', async ({ browser }) => {
    const room = uniq('fwrelay');
    const relayMe = () => localStorage.setItem('ezspeak_relay_only', '1');
    // TURN of this host is unreachable → relay-only links can't connect
    const a = await openUser(browser, relayBase, room, 'alice', { init: relayMe });
    await fastTimings(a.page);
    const b = await openUser(browser, relayBase, room, 'bob', { init: relayMe });
    await fastTimings(b.page);
    const dialog = a.page.locator('#network-warning-modal');
    await expect(dialog).toBeVisible({ timeout: 15000 });
    await expect(dialog).toContainText('even through the relay');
    await expect(a.page.locator('#network-warning-relay-room')).toBeHidden();
    if (process.env.E2E_SCREENSHOTS) await a.page.screenshot({ path: process.env.E2E_SCREENSHOTS + '/relay-blocked.png' });
    await a.context.close(); await b.context.close();
  });

  test('a working connection never shows the warning', async ({ browser, baseURL }) => {
    const room = uniq('fwok');
    const a = await openUser(browser, baseURL, room, 'alice');
    await fastTimings(a.page);
    const b = await openUser(browser, baseURL, room, 'bob');
    await expectAudioFrom(a.page, [await myId(b.page)]);
    await a.page.waitForTimeout(3500);
    await expect(a.page.locator('#network-warning-modal')).toBeHidden();
    await a.context.close(); await b.context.close();
  });

  test('blocked WebSocket shows a server-unreachable warning', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, permissions: ['microphone'] });
    await context.addInitScript(blockWebSocket);
    const page = await context.newPage();
    await page.goto(`/server/${uniq('ws')}`);
    const dialog = page.locator('#network-warning-modal');
    await expect(dialog).toBeVisible({ timeout: 15000 });
    await expect(dialog).toContainText("Can't reach the server");
    await expect(dialog).toContainText('WebSocket');   // HTTP works → WebSockets are filtered
    await expect(page.locator('#network-warning-relay-room')).toBeHidden();
    await context.close();
  });
});
