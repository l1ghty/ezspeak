// Integration tests: real HTTP + WebSocket server on an ephemeral port.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, connect, join, joinChannel, sleep } = require('./helpers');

const RELAY = 'candidate:4 1 udp 41885439 198.51.100.9 50000 typ relay raddr 203.0.113.7 rport 40000';
const SRFLX = 'candidate:3 1 udp 1686052607 203.0.113.7 40000 typ srflx raddr 192.168.1.20 rport 54321';
const SDP = 'v=0\r\nc=IN IP4 203.0.113.7\r\na=' + SRFLX + '\r\na=' + RELAY + '\r\n';

async function withServer(env, fn) {
  const srv = await startServer(env);
  const clients = [];
  try {
    await fn(srv, clients);
  } finally {
    clients.forEach(c => { try { c.ws.terminate(); } catch {} });
    await srv.close();
  }
}

test('HTTP: health, landing, server page OG escaping, canonical redirect', async () => {
  await withServer({}, async (srv) => {
    const health = await fetch(srv.http + '/health');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ok');

    const landing = await (await fetch(srv.http + '/')).text();
    assert.ok(landing.includes('ezspeak'));
    assert.ok(!landing.includes('{{OG_TITLE}}'));

    const redirect = await fetch(srv.http + '/server/My%20Room', { redirect: 'manual' });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get('location'), '/server/my-room');

    const page = await (await fetch(srv.http + '/server/a%22%3E%3Cb%3E')).text();
    assert.ok(!page.includes('"><b>'), 'server name is HTML-escaped in OG tags');
    assert.ok(page.includes('a&quot;&gt;&lt;b&gt;'));

    const js = await fetch(srv.http + '/js/shared.js');
    assert.equal(js.status, 200);
  });
});

test('join-server creates a server; first user is creator; others are notified', async () => {
  await withServer({}, async (srv, cl) => {
    const a = await join(srv, 'Room One', 'alice'); cl.push(a);
    assert.equal(a.state.type, 'server-state');
    assert.equal(a.state.serverName, 'room-one', 'server name normalized');
    assert.equal(a.state.creator, a.id);
    assert.ok(a.state.reconnectToken);
    assert.ok(Array.isArray(a.state.iceServers));
    assert.deepEqual(Object.keys(a.state.channels), ['lobby', 'channel 1', 'channel 2']);

    const b = await join(srv, 'room-one', 'bob'); cl.push(b);
    assert.notEqual(b.state.creator, b.id);
    const joined = await a.next('user-joined-server');
    assert.equal(joined.userId, b.id);
    assert.equal(joined.username, 'bob');
    assert.ok(!JSON.stringify(b.state).includes(a.state.reconnectToken), 'other users never see your token');
  });
});

test('second join-server on same socket is rejected (no ghost users)', async () => {
  await withServer({}, async (srv, cl) => {
    const a = await join(srv, 'r', 'alice'); cl.push(a);
    a.send({ type: 'join-server', serverName: 'r', username: 'again' });
    assert.equal((await a.next('error')).code, 'ALREADY_JOINED');
    assert.equal(srv.state.getServer('r').users.size, 1);
  });
});

test('password protected servers', async () => {
  await withServer({}, async (srv, cl) => {
    const a = await join(srv, 'secret', 'alice', { password: 'pw1' }); cl.push(a);
    assert.equal(a.state.hasPassword, true);
    const noPw = await join(srv, 'secret', 'bob'); cl.push(noPw);
    assert.equal(noPw.state.type, 'password-required');
    assert.equal(noPw.state.wrong, false);
    const wrong = await join(srv, 'secret', 'bob', { password: 'nope' }); cl.push(wrong);
    assert.equal(wrong.state.wrong, true);
    const ok = await join(srv, 'secret', 'bob', { password: 'pw1' }); cl.push(ok);
    assert.equal(ok.state.type, 'server-state');

    // Only the creator may change it
    ok.send({ type: 'set-password', password: 'x' });
    assert.equal((await ok.next('error')).code, 'NOT_CREATOR');
    a.send({ type: 'set-password', password: '' });
    assert.equal((await ok.next('password-updated')).hasPassword, false);
  });
});

test('limits: max servers, servers per IP, users per server, channels', async () => {
  await withServer({ MAX_SERVERS: '2', MAX_SERVERS_PER_IP: '5', MAX_USERS_PER_SERVER: '2', MAX_CHANNELS_PER_SERVER: '4' }, async (srv, cl) => {
    const a = await join(srv, 's1', 'a'); cl.push(a);
    const b = await join(srv, 's2', 'b'); cl.push(b);
    const c = await join(srv, 's3', 'c'); cl.push(c);
    assert.equal(c.state.code, 'SERVER_LIMIT');

    const a2 = await join(srv, 's1', 'a2'); cl.push(a2);
    const a3 = await join(srv, 's1', 'a3'); cl.push(a3);
    assert.equal(a3.state.code, 'SERVER_FULL');

    a.send({ type: 'add-channel', channelName: 'Extra' });
    assert.equal((await a2.next('channel-added')).channelKey, 'extra');
    a.send({ type: 'add-channel', channelName: 'Too many' });
    assert.equal((await a.next('error')).code, 'CHANNEL_LIMIT');
    a2.send({ type: 'add-channel', channelName: 'Nope' });
    assert.equal((await a2.next('error')).code, 'NOT_CREATOR');
  });

  await withServer({ MAX_SERVERS_PER_IP: '1' }, async (srv, cl) => {
    const a = await join(srv, 'mine', 'a'); cl.push(a);
    const b = await join(srv, 'another', 'a'); cl.push(b);
    assert.equal(b.state.code, 'SERVER_LIMIT_IP');
    const c = await join(srv, 'mine', 'c'); cl.push(c);
    assert.equal(c.state.type, 'server-state', 'joining existing servers is not limited per IP');
  });
});

test('limits: connections per IP (honours X-Forwarded-For only with TRUST_PROXY)', async () => {
  await withServer({ MAX_CONNECTIONS_PER_IP: '2', TRUST_PROXY: '1' }, async (srv, cl) => {
    const h = { 'x-forwarded-for': '10.0.0.1' };
    cl.push(await connect(srv, h), await connect(srv, h));
    const third = await connect(srv, h); cl.push(third);
    const closed = await third.closed;
    assert.equal(closed.code, 1013);
    const other = await connect(srv, { 'x-forwarded-for': '10.0.0.2' }); cl.push(other);
    assert.equal(await Promise.race([other.closed.then(() => 'closed'), sleep(100).then(() => 'open')]), 'open');
  });
});

test('creator can set per-server user and channel limits (bounded by host limits)', async () => {
  await withServer({ MAX_USERS_PER_SERVER: '10', MAX_USERS_PER_CHANNEL: '5' }, async (srv, cl) => {
    const a = await join(srv, 'lim', 'a'); cl.push(a);
    a.send({ type: 'update-server-settings', maxUsers: 2, maxUsersPerChannel: 99 });
    const upd = await a.next('server-settings-updated');
    assert.equal(upd.maxUsers, 2);
    assert.equal(upd.maxUsersPerChannel, 5, 'clamped to host limit');
    const b = await join(srv, 'lim', 'b'); cl.push(b);
    const c = await join(srv, 'lim', 'c'); cl.push(c);
    assert.equal(c.state.code, 'SERVER_FULL');

    a.send({ type: 'update-server-settings', maxUsersPerChannel: 2 });
    await a.next('server-settings-updated');
    a.send({ type: 'update-server-settings', maxUsers: 0 });
    assert.equal((await a.next('error')).code, 'INVALID_SETTING');
  });
});

test('channel join/switch/leave notifications and channel capacity', async () => {
  await withServer({ MAX_USERS_PER_CHANNEL: '2' }, async (srv, cl) => {
    const a = await join(srv, 'ch', 'a'); cl.push(a);
    const b = await join(srv, 'ch', 'b'); cl.push(b);
    const c = await join(srv, 'ch', 'c'); cl.push(c);

    const ja = await joinChannel(a, 'lobby');
    assert.deepEqual(ja.existingPeers, []);
    const jb = await joinChannel(b, 'lobby');
    assert.deepEqual(jb.existingPeers, [a.id]);
    assert.equal(jb.peerDetails[0].username, 'a');
    const pj = await a.next('peer-joined-channel');
    assert.equal(pj.userId, b.id);

    c.send({ type: 'join-channel', channelName: 'lobby' });
    assert.equal((await c.next('error')).code, 'CHANNEL_FULL');

    c.send({ type: 'join-channel', channelName: 'nope' });
    assert.equal((await c.next('error')).code, 'CHANNEL_NOT_FOUND');

    // Switching channels directly tells the old channel
    const sw = await joinChannel(b, 'channel 1');
    assert.equal(sw.previousChannel, 'lobby');
    assert.equal((await a.next('peer-left-channel')).userId, b.id);

    b.send({ type: 'leave-channel' });
    assert.equal((await b.next('left-channel')).channelName, 'channel 1');
    const upd = await c.next('user-channel-update', m => m.userId === b.id && m.channelName === null);
    assert.ok(upd);
  });
});

test('WebRTC signaling is relayed only within the same channel, with connId', async () => {
  await withServer({}, async (srv, cl) => {
    const a = await join(srv, 'rtc', 'a'); cl.push(a);
    const b = await join(srv, 'rtc', 'b'); cl.push(b);
    const c = await join(srv, 'rtc', 'c'); cl.push(c);
    await joinChannel(a, 'lobby'); await joinChannel(b, 'lobby'); await joinChannel(c, 'channel 1');

    a.send({ type: 'webrtc-offer', targetId: b.id, connId: 'x1', offer: { type: 'offer', sdp: SDP, evil: 1 } });
    const got = await b.next('webrtc-offer');
    assert.equal(got.fromId, a.id);
    assert.equal(got.connId, 'x1');
    assert.deepEqual(Object.keys(got.offer).sort(), ['sdp', 'type'], 'only whitelisted fields are forwarded');
    assert.equal(got.offer.sdp, SDP, 'no sanitizing in normal mode');

    b.send({ type: 'webrtc-ice-candidate', targetId: a.id, connId: 'x1', candidate: { candidate: SRFLX, sdpMid: '0', sdpMLineIndex: 0 } });
    assert.equal((await a.next('webrtc-ice-candidate')).candidate.candidate, SRFLX);

    // Cross-channel, missing connId, self-targeting and malformed signals are dropped
    a.send({ type: 'webrtc-offer', targetId: c.id, connId: 'x2', offer: { type: 'offer', sdp: SDP } });
    a.send({ type: 'webrtc-offer', targetId: b.id, offer: { type: 'offer', sdp: SDP } });
    a.send({ type: 'webrtc-offer', targetId: a.id, connId: 'x3', offer: { type: 'offer', sdp: SDP } });
    a.send({ type: 'webrtc-answer', targetId: b.id, connId: 'x4', answer: { type: 'bogus', sdp: SDP } });
    assert.ok(await c.none('webrtc-offer'));
    assert.ok(await b.none('webrtc-offer'));
    assert.ok(await b.none('webrtc-answer'));
  });
});

test('signaling bursts (many ICE candidates) are not rate limited away', async () => {
  await withServer({}, async (srv, cl) => {
    const a = await join(srv, 'burst', 'a'); cl.push(a);
    const b = await join(srv, 'burst', 'b'); cl.push(b);
    await joinChannel(a, 'lobby'); await joinChannel(b, 'lobby');
    for (let i = 0; i < 120; i++) {
      a.send({ type: 'webrtc-ice-candidate', targetId: b.id, connId: 'c', candidate: { candidate: SRFLX + ' #' + i, sdpMid: '0', sdpMLineIndex: 0 } });
    }
    for (let i = 0; i < 120; i++) await b.next('webrtc-ice-candidate');
  });
});

test('chat spam is rate limited', async () => {
  await withServer({}, async (srv, cl) => {
    const a = await join(srv, 'spam', 'a'); cl.push(a);
    await joinChannel(a, 'lobby');
    for (let i = 0; i < 60; i++) a.send({ type: 'chat-message', message: 'm' + i });
    await sleep(200);
    const got = a.messages.filter(m => m.type === 'chat-message').length;
    assert.ok(got >= 8 && got <= 13, `expected ~10 delivered, got ${got}`);
    assert.ok(a.messages.some(m => m.type === 'error' && m.code === 'RATE_LIMITED'), 'sender is told to slow down');
  });
});

test('relay-only server strips non-relay candidates and IPs from signaling', async () => {
  await withServer({ TURN_URLS: 'turn:turn.example:3478', TURN_SECRET: 'sec' }, async (srv, cl) => {
    const a = await join(srv, 'priv', 'a'); cl.push(a);
    const b = await join(srv, 'priv', 'b'); cl.push(b);
    assert.equal(a.state.relayAvailable, true);
    assert.ok(a.state.iceServers.some(s => s.urls.includes('turn:turn.example:3478') && s.username && s.credential));

    a.send({ type: 'update-server-settings', relayOnly: true });
    const upd = await b.next('server-settings-updated');
    assert.equal(upd.relayOnly, true);
    assert.equal(upd.forceRelay, true);

    await joinChannel(a, 'lobby'); await joinChannel(b, 'lobby');
    a.send({ type: 'webrtc-offer', targetId: b.id, connId: 'p', offer: { type: 'offer', sdp: SDP } });
    const off = await b.next('webrtc-offer');
    assert.ok(!off.offer.sdp.includes('203.0.113.7'), 'public IP removed from SDP');
    assert.ok(!off.offer.sdp.includes('192.168.1.20'));
    assert.ok(off.offer.sdp.includes('typ relay raddr 0.0.0.0 rport 0'));

    a.send({ type: 'webrtc-ice-candidate', targetId: b.id, connId: 'p', candidate: { candidate: SRFLX, sdpMid: '0', sdpMLineIndex: 0 } });
    a.send({ type: 'webrtc-ice-candidate', targetId: b.id, connId: 'p', candidate: { candidate: RELAY, sdpMid: '0', sdpMLineIndex: 0 } });
    const cand = await b.next('webrtc-ice-candidate');
    assert.ok(cand.candidate.candidate.includes('typ relay raddr 0.0.0.0'));
    assert.ok(await b.none('webrtc-ice-candidate'), 'srflx candidate was dropped');
  });
});

test('relay-only cannot be enabled without TURN; per-user privacy still sanitizes', async () => {
  await withServer({}, async (srv, cl) => {
    const a = await join(srv, 'noturn', 'a', { relayOnly: true }); cl.push(a);
    const b = await join(srv, 'noturn', 'b'); cl.push(b);
    a.send({ type: 'update-server-settings', relayOnly: true });
    assert.equal((await a.next('error')).code, 'RELAY_UNAVAILABLE');

    await joinChannel(a, 'lobby'); await joinChannel(b, 'lobby');
    // a asked for privacy → a's candidates are filtered…
    a.send({ type: 'webrtc-ice-candidate', targetId: b.id, connId: 'q', candidate: { candidate: SRFLX } });
    assert.ok(await b.none('webrtc-ice-candidate'));
    // …b did not, so b's are not.
    b.send({ type: 'webrtc-ice-candidate', targetId: a.id, connId: 'q', candidate: { candidate: SRFLX } });
    assert.ok(await a.next('webrtc-ice-candidate'));

    b.send({ type: 'set-privacy', relayOnly: true });
    assert.equal((await b.next('privacy-updated')).relayOnly, true);
    b.send({ type: 'webrtc-ice-candidate', targetId: a.id, connId: 'q', candidate: { candidate: SRFLX } });
    assert.ok(await a.none('webrtc-ice-candidate'));
  });
});

test('FORCE_RELAY applies to every server', async () => {
  await withServer({ FORCE_RELAY: '1', TURN_URLS: 'turn:t', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' }, async (srv, cl) => {
    const a = await join(srv, 'f', 'a'); cl.push(a);
    assert.equal(a.state.forceRelay, true);
    assert.equal(a.state.relayOnly, false);
  });
});

test('reconnect within grace period resumes the same session and channel', async () => {
  await withServer({ DISCONNECT_GRACE_MS: '2000' }, async (srv, cl) => {
    const a = await join(srv, 'rc', 'a'); cl.push(a);
    const b = await join(srv, 'rc', 'b'); cl.push(b);
    await joinChannel(a, 'lobby'); await joinChannel(b, 'lobby');
    const token = a.state.reconnectToken;

    a.ws.terminate();
    await sleep(100);
    assert.ok(srv.state.getUser(srv.state.getServer('rc'), a.id), 'user kept during grace');
    assert.ok(await b.none('user-left-server', 100));

    const a2 = await connect(srv); cl.push(a2);
    a2.send({ type: 'reconnect-session', serverName: 'rc', userId: a.id, reconnectToken: token });
    const st = await a2.next('server-state');
    assert.equal(st.reconnected, true);
    assert.equal(st.yourUserId, a.id);
    assert.equal(st.users[a.id].channelName, 'lobby');
    const back = await b.next('peer-joined-channel');
    assert.equal(back.reconnected, true);

    // The resumed socket must be fully functional (regression: context was lost)
    a2.send({ type: 'webrtc-offer', targetId: b.id, connId: 'z', offer: { type: 'offer', sdp: SDP } });
    assert.equal((await b.next('webrtc-offer')).fromId, a.id);
    a2.send({ type: 'chat-message', message: 'hi' });
    assert.equal((await b.next('chat-message')).message, 'hi');
  });
});

test('reconnect takes over a still-open stale socket', async () => {
  await withServer({}, async (srv, cl) => {
    const a = await join(srv, 'take', 'a'); cl.push(a);
    const a2 = await connect(srv); cl.push(a2);
    a2.send({ type: 'reconnect-session', serverName: 'take', userId: a.id, reconnectToken: a.state.reconnectToken });
    assert.equal((await a2.next('server-state')).reconnected, true);
    const closed = await a.closed;
    assert.equal(closed.code, 4000);
    await sleep(50);
    assert.equal(srv.state.getServer('take').users.size, 1, 'old socket close does not remove the user');
  });
});

test('reconnect with a bad token fails', async () => {
  await withServer({}, async (srv, cl) => {
    const a = await join(srv, 'bad', 'a'); cl.push(a);
    const x = await connect(srv); cl.push(x);
    x.send({ type: 'reconnect-session', serverName: 'bad', userId: a.id, reconnectToken: 'nope' });
    assert.equal((await x.next('error')).code, 'RECONNECT_FAILED');
    x.send({ type: 'chat-message', message: 'hijack' });
    assert.equal((await x.next('error')).code, 'NOT_IN_SERVER');
  });
});

test('grace expiry removes the user, notifies peers and hands over creator', async () => {
  await withServer({ DISCONNECT_GRACE_MS: '100' }, async (srv, cl) => {
    const a = await join(srv, 'gr', 'a'); cl.push(a);
    const b = await join(srv, 'gr', 'b'); cl.push(b);
    await joinChannel(a, 'lobby'); await joinChannel(b, 'lobby');
    a.ws.terminate();
    assert.equal((await b.next('peer-left-channel', () => true, 1000)).userId, a.id);
    assert.equal((await b.next('user-left-server')).userId, a.id);
    assert.equal((await b.next('creator-changed')).creator, b.id);
    b.send({ type: 'add-channel', channelName: 'Mine now' });
    assert.ok(await b.next('channel-added'));
  });
});

test('intentional disconnect removes immediately; empty servers are deleted', async () => {
  await withServer({ DISCONNECT_GRACE_MS: '60000' }, async (srv, cl) => {
    const a = await join(srv, 'bye', 'a'); cl.push(a);
    const b = await join(srv, 'bye', 'b'); cl.push(b);
    a.send({ type: 'disconnect' });
    assert.equal((await b.next('user-left-server')).userId, a.id);
    b.send({ type: 'disconnect' });
    await sleep(50);
    assert.equal(srv.state.getServer('bye'), null);
  });
});

test('mute/deafen state persists and is broadcast; rename; avatar validation', async () => {
  await withServer({}, async (srv, cl) => {
    const a = await join(srv, 'st', 'a'); cl.push(a);
    const b = await join(srv, 'st', 'b'); cl.push(b);
    await joinChannel(a, 'lobby'); await joinChannel(b, 'lobby');
    a.send({ type: 'mute-state-changed', value: true });
    assert.equal((await b.next('mute-state-changed')).value, true);
    const c = await join(srv, 'st', 'c'); cl.push(c);
    assert.equal(c.state.users[a.id].isMuted, true);

    a.send({ type: 'change-username', username: 'alice' });
    assert.equal((await b.next('user-renamed')).newUsername, 'alice');

    a.send({ type: 'avatar-changed', avatar: 'data:image/png;base64,AA" onerror="alert(1)' });
    assert.equal((await b.next('avatar-changed')).avatar, null);
    a.send({ type: 'avatar-changed', avatar: 'data:image/png;base64,AAAA' });
    assert.equal((await b.next('avatar-changed')).avatar, 'data:image/png;base64,AAAA');

    a.send({ type: 'file-announce', fileId: 'bad"id', fileName: 'x.txt', fileSize: 3 });
    assert.ok(await b.none('file-announce'));
    a.send({ type: 'file-announce', fileId: 'abc123', fileName: 'x.txt', fileSize: 3, fileType: 'text/plain' });
    assert.equal((await b.next('file-announce')).fileId, 'abc123');
  });
});

test('messages before joining are rejected; ping gets pong; garbage is ignored', async () => {
  await withServer({}, async (srv, cl) => {
    const x = await connect(srv); cl.push(x);
    x.ws.send('not json');
    x.send({ type: 'join-channel', channelName: 'lobby' });
    assert.equal((await x.next('error')).code, 'NOT_IN_SERVER');
    x.send({ type: 'ping' });
    assert.ok(await x.next('pong'));
  });
});

test('createRelayOnly creates a relay-only server (only when TURN is available)', async () => {
  await withServer({ TURN_URLS: 'turn:t', TURN_SECRET: 's' }, async (srv, cl) => {
    const a = await join(srv, 'fresh-relay', 'a', { createRelayOnly: true }); cl.push(a);
    assert.equal(a.state.relayOnly, true);
    assert.equal(a.state.forceRelay, true);
    assert.equal(a.state.createdServer, true);
    // Joining an existing room ignores the flag (and does not report creation)
    const plain = await join(srv, 'plain', 'b'); cl.push(plain);
    const c = await join(srv, 'plain', 'c', { createRelayOnly: true }); cl.push(c);
    assert.equal(c.state.relayOnly, false);
    assert.equal(c.state.createdServer, undefined);
  });
  await withServer({}, async (srv, cl) => {
    const a = await join(srv, 'want-relay', 'a', { createRelayOnly: true }); cl.push(a);
    assert.equal(a.state.code, 'RELAY_UNAVAILABLE');
    assert.equal(srv.state.getServer('want-relay'), null, 'no normal room created instead');
  });
});

test('TURN URLs default to the host the client connected to', async () => {
  await withServer({ TURN_SECRET: 'sec', STUN_URLS: '' }, async (srv, cl) => {
    const a = await join(srv, 'auto-turn', 'a', { headers: { host: 'voice.example.org:3111' } }); cl.push(a);
    assert.equal(a.state.relayAvailable, true);
    assert.deepEqual(a.state.iceServers[0].urls,
      ['turn:voice.example.org:3478?transport=udp', 'turn:voice.example.org:3478?transport=tcp']);
    assert.match(a.state.iceServers[0].username, /^\d+:\d+$/);
  });
  await withServer({ TURN_SECRET: 'sec', STUN_URLS: '', TRUST_PROXY: '1' }, async (srv, cl) => {
    const a = await join(srv, 'proxied', 'a', { headers: { host: 'internal:3111', 'x-forwarded-host': 'public.example' } }); cl.push(a);
    assert.equal(a.state.iceServers[0].urls[0], 'turn:public.example:3478?transport=udp');
  });
});

// ── Abuse protection ────────────────────────────────────────────────────────

test('WebSockets from foreign origins are refused', async () => {
  await withServer({}, async (srv) => {
    const WebSocket = require('ws');
    const status = (headers) => new Promise((resolve) => {
      const ws = new WebSocket(srv.url, { headers });
      ws.on('open', () => { ws.close(); resolve('open'); });
      ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
      ws.on('error', () => {});
    });
    assert.equal(await status({ origin: 'https://evil.example' }), 403);
    assert.equal(await status({ origin: `http://127.0.0.1:${srv.port}` }), 'open');
    assert.equal(await status({}), 'open');
  });
  await withServer({ ALLOWED_ORIGINS: 'https://partner.example' }, async (srv, cl) => {
    cl.push(await connect(srv, { origin: 'https://partner.example' }));
  });
});

test('new connections per IP are rate limited', async () => {
  await withServer({ CONNECT_RATE_PER_IP: '3' }, async (srv, cl) => {
    for (let i = 0; i < 3; i++) cl.push(await connect(srv));
    const WebSocket = require('ws');
    const code = await new Promise((resolve) => {
      const ws = new WebSocket(srv.url);
      ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
      ws.on('open', () => resolve('open'));
      ws.on('error', () => {});
    });
    assert.equal(code, 429);
  });
});

test('sockets that never join are closed', async () => {
  await withServer({ JOIN_TIMEOUT_MS: '1000' }, async (srv, cl) => {
    const idle = await connect(srv); cl.push(idle);
    const joined = await join(srv, 'stay', 'a'); cl.push(joined);
    assert.equal((await idle.closed).code, 4008);
    assert.ok(await joined.none('error', 200));
    assert.equal(joined.ws.readyState, 1, 'joined sockets stay open');
  });
});

test('wrong passwords lock the IP out after the limit', async () => {
  await withServer({ PASSWORD_FAILS_PER_IP: '3' }, async (srv, cl) => {
    const owner = await join(srv, 'vault', 'owner', { password: 'right' }); cl.push(owner);
    for (let i = 0; i < 3; i++) {
      const c = await join(srv, 'vault', 'x', { password: 'wrong' + i }); cl.push(c);
      assert.equal(c.state.type, 'password-required');
    }
    const locked = await join(srv, 'vault', 'x', { password: 'right' }); cl.push(locked);
    assert.equal(locked.state.code, 'TOO_MANY_ATTEMPTS', 'even the right password is refused while locked');
    // Asking without a password (the normal first step) doesn't count as a failure
    const ask = await join(srv, 'other', 'y'); cl.push(ask);
    assert.equal(ask.state.type, 'server-state');
  });
});

test('password checks do not block the event loop', async () => {
  await withServer({}, async (srv, cl) => {
    const owner = await join(srv, 'busy', 'owner', { password: 'pw' }); cl.push(owner);
    await joinChannel(owner, 'lobby');
    // Fire several password checks and measure event loop responsiveness meanwhile.
    const tries = [];
    for (let i = 0; i < 6; i++) tries.push(join(srv, 'busy', 'x' + i, { password: 'pw' }));
    const t0 = Date.now();
    owner.send({ type: 'ping' });
    await owner.next('pong');
    const pingMs = Date.now() - t0;
    const res = await Promise.all(tries); cl.push(...res);
    assert.ok(res.every(r => r.state.type === 'server-state'));
    assert.ok(pingMs < 150, `ping took ${pingMs}ms while hashing`);
  });
});

test('creator can kick (and ban) a user; others cannot', async () => {
  await withServer({ DISCONNECT_GRACE_MS: '60000' }, async (srv, cl) => {
    const owner = await join(srv, 'mod', 'owner'); cl.push(owner);
    const troll = await join(srv, 'mod', 'troll', { headers: { 'x-forwarded-for': '9.9.9.9' } }); cl.push(troll);
    const other = await join(srv, 'mod', 'other'); cl.push(other);
    await joinChannel(owner, 'lobby'); await joinChannel(troll, 'lobby');

    other.send({ type: 'kick-user', userId: troll.id });
    assert.equal((await other.next('error')).code, 'NOT_CREATOR');

    owner.send({ type: 'kick-user', userId: troll.id });
    assert.ok(await troll.next('kicked'));
    assert.equal((await troll.closed).code, 4003);
    assert.equal((await owner.next('peer-left-channel')).userId, troll.id);
    assert.equal((await other.next('user-kicked')).userId, troll.id);
    assert.equal(srv.state.getUser(srv.state.getServer('mod'), troll.id), null, 'removed immediately, no grace');

    // Banned for this server's lifetime (TRUST_PROXY is off, so the ban is on the socket IP)
    const again = await join(srv, 'mod', 'troll2'); cl.push(again);
    assert.equal(again.state.code, 'BANNED');
    owner.send({ type: 'kick-user', userId: owner.id });   // can't kick yourself
    assert.ok(await owner.none('kicked'));
  });
});

test('avatar broadcasts and renames are rate limited per user', async () => {
  await withServer({}, async (srv, cl) => {
    const a = await join(srv, 'av', 'a'); cl.push(a);
    const b = await join(srv, 'av', 'b'); cl.push(b);
    for (let i = 0; i < 10; i++) a.send({ type: 'avatar-changed', avatar: 'data:image/png;base64,AAAA' });
    for (let i = 0; i < 10; i++) a.send({ type: 'change-username', username: 'n' + i });
    await sleep(200);
    assert.equal(b.messages.filter(m => m.type === 'avatar-changed').length, 3);
    assert.equal(b.messages.filter(m => m.type === 'user-renamed').length, 3);
  });
});

test('per-socket byte budget caps signaling floods', async () => {
  await withServer({}, async (srv, cl) => {
    const a = await join(srv, 'flood', 'a'); cl.push(a);
    const b = await join(srv, 'flood', 'b'); cl.push(b);
    await joinChannel(a, 'lobby'); await joinChannel(b, 'lobby');
    const sdp = 'v=0\r\n' + 'a=x'.repeat(7000);   // ~21 KB, under sdpMax
    for (let i = 0; i < 60; i++) a.send({ type: 'webrtc-offer', targetId: b.id, connId: 'c' + i, offer: { type: 'offer', sdp } });
    await sleep(300);
    const got = b.messages.filter(m => m.type === 'webrtc-offer').length;
    assert.ok(got > 15 && got < 35, `512 KB burst ≈ 24 offers forwarded, got ${got}`);
    b.messages.length = 0;
    await sleep(1000);   // refill the byte budget
    a.send({ type: 'webrtc-offer', targetId: b.id, connId: 'ok', offer: { type: 'offer', sdp: 'v=0' } });
    assert.ok(await b.next('webrtc-offer'), 'budget refills');
    a.send({ type: 'webrtc-offer', targetId: b.id, connId: 'big', offer: { type: 'offer', sdp: 'a'.repeat(40000) } });
    assert.ok(await b.none('webrtc-offer', 100), 'SDP over 32 KB is dropped');
  });
});

test('spoofing characters in names are rejected', async () => {
  await withServer({}, async (srv, cl) => {
    const a = await join(srv, 'spoof', 'admin‮'); cl.push(a);
    assert.equal(a.state.users[a.id].username, 'User');
  });
});

test('clients learn the TURN credential lifetime', async () => {
  await withServer({ TURN_SECRET: 's', TURN_TTL: '600' }, async (srv, cl) => {
    const a = await join(srv, 'ttl', 'a'); cl.push(a);
    assert.equal(a.state.iceTtlSec, 600);
    a.send({ type: 'get-ice-servers' });
    assert.equal((await a.next('ice-servers')).iceTtlSec, 600);
  });
});
