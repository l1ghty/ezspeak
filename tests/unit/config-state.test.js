const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { loadConfig } = require('../../server/config');
const { buildIceServers, turnRestCredentials } = require('../../server/ice');
const St = require('../../server/state');
const { takeToken } = require('../../server/handlers');

test('loadConfig defaults', () => {
  const c = loadConfig({});
  assert.equal(c.port, 3000);
  assert.equal(c.limits.maxServers, 100);
  assert.equal(c.limits.maxUsersPerChannel, 10);
  assert.equal(c.ice.forceRelay, false);
  assert.equal(c.ice.relayAvailable, false);
  assert.equal(c.ice.stunUrls.length, 2);
});

test('loadConfig parses env, clamps and validates', () => {
  const c = loadConfig({
    PORT: '8080', MAX_SERVERS: '3', MAX_USERS_PER_SERVER: '5', MAX_USERS_PER_CHANNEL: '50',
    MAX_SERVERS_PER_IP: 'nope', FORCE_RELAY: 'yes', TURN_URLS: 'turn:a:3478, turns:a:5349',
    TURN_SECRET: 's3cret', STUN_URLS: '', TRUST_PROXY: '1',
  });
  assert.equal(c.port, 8080);
  assert.equal(c.limits.maxServers, 3);
  assert.equal(c.limits.maxServersPerIp, 5, 'invalid number falls back to default');
  assert.equal(c.limits.maxUsersPerChannel, 5, 'channel limit never exceeds server limit');
  assert.equal(c.ice.forceRelay, true);
  assert.deepEqual(c.ice.turnUrls, ['turn:a:3478', 'turns:a:5349']);
  assert.deepEqual(c.ice.stunUrls, []);
  assert.equal(c.ice.relayAvailable, true);
  assert.equal(c.trustProxy, true);
  assert.equal(loadConfig({ TURN_URLS: 'turn:a' }).ice.relayAvailable, false, 'TURN without credentials is not usable');
  assert.equal(loadConfig({ TURN_URLS: 'turn:a', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' }).ice.relayAvailable, true);
});

test('TURN REST credentials match coturn algorithm', () => {
  const now = 1_700_000_000_000;
  const { username, credential } = turnRestCredentials('secret', '42', 3600, now);
  assert.equal(username, `${1_700_000_000 + 3600}:42`);
  assert.equal(credential, crypto.createHmac('sha1', 'secret').update(username).digest('base64'));
});

test('buildIceServers', () => {
  const base = loadConfig({}).ice;
  assert.deepEqual(buildIceServers(base, '1'), [{ urls: base.stunUrls }]);
  const turn = loadConfig({ TURN_URLS: 'turn:t:3478', TURN_SECRET: 'x' }).ice;
  const list = buildIceServers(turn, '7');
  assert.equal(list.length, 2);
  assert.deepEqual(list[1].urls, ['turn:t:3478']);
  assert.match(list[1].username, /^\d+:7$/);
  const stat = loadConfig({ TURN_URLS: 'turn:t', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p', STUN_URLS: '' }).ice;
  assert.deepEqual(buildIceServers(stat, '1'), [{ urls: ['turn:t'], username: 'u', credential: 'p' }]);
});

test('password hashing', () => {
  const h = St.hashPassword('hunter2');
  assert.equal(St.verifyPassword('hunter2', h), true);
  assert.equal(St.verifyPassword('hunter3', h), false);
  assert.equal(St.verifyPassword('', h), false);
  assert.equal(St.verifyPassword(undefined, h), false);
  assert.equal(St.verifyPassword('x', null), true);
  assert.equal(St.verifyPassword('x', 'garbage'), false);
});

test('validateString / validateAvatar', () => {
  assert.equal(St.validateString('  hi  ', 5), 'hi');
  assert.equal(St.validateString('toolong', 3), null);
  assert.equal(St.validateString('a\x07b', 10), null);
  assert.equal(St.validateString('   ', 10), null);
  assert.equal(St.validateString(5, 10), null);
  assert.equal(St.validateAvatar('data:image/png;base64,AAAA', 100), 'data:image/png;base64,AAAA');
  assert.equal(St.validateAvatar('data:image/png;base64,AA" onerror="x', 100), null, 'rejects attribute injection');
  assert.equal(St.validateAvatar('data:image/svg+xml;base64,AAAA', 100), null);
  assert.equal(St.validateAvatar('data:image/png;base64,' + 'A'.repeat(200), 100), null);
});

test('safeEqual', () => {
  assert.equal(St.safeEqual('abc', 'abc'), true);
  assert.equal(St.safeEqual('abc', 'abd'), false);
  assert.equal(St.safeEqual('abc', 'ab'), false);
  assert.equal(St.safeEqual(undefined, 'ab'), false);
});

test('token bucket refills over time', () => {
  const b = {};
  let ok = 0;
  for (let i = 0; i < 50; i++) if (takeToken(b, 'general', 1000)) ok++;
  assert.equal(ok, 20, 'burst capacity');
  assert.equal(takeToken(b, 'general', 1000), false);
  assert.equal(takeToken(b, 'general', 1200), true, '10/s refill → 2 tokens after 200ms');
  const s = {};
  let sig = 0;
  for (let i = 0; i < 500; i++) if (takeToken(s, 'signal', 0)) sig++;
  assert.equal(sig, 400, 'signaling bursts are allowed');
});

test('state: servers, users, channels and cleanup', () => {
  const cfg = loadConfig({ MAX_CHANNELS_PER_SERVER: '4', MAX_USERS_PER_CHANNEL: '2' });
  const s = St.createState(cfg);
  const srv = s.createServer('room', { password: 'pw', ip: '1.1.1.1' });
  assert.equal(s.serverCount(), 1);
  assert.equal(s.serversCreatedByIp('1.1.1.1'), 1);
  assert.equal(s.checkPassword(srv, 'pw'), true);
  assert.equal(s.checkPassword(srv, 'nope'), false);

  const a = s.addUser(srv, { username: 'A' });
  const b = s.addUser(srv, { username: 'B' });
  const c = s.addUser(srv, { username: 'C' });
  assert.equal(srv.creatorId, a.id, 'first user is creator');
  assert.notEqual(a.token, b.token);

  assert.deepEqual(s.joinChannel(srv, a, 'lobby'), { oldKey: null });
  s.joinChannel(srv, b, 'lobby');
  assert.equal(s.channelFull(srv, 'lobby'), true);
  assert.deepEqual(s.channelPeers(srv, 'lobby', a.id).map(u => u.id), [b.id]);

  assert.deepEqual(s.joinChannel(srv, a, 'channel 1'), { oldKey: 'lobby' });
  assert.equal(srv.channels.get('lobby').users.has(a.id), false);
  assert.equal(s.leaveChannel(srv, a), 'channel 1');
  assert.equal(s.leaveChannel(srv, a), null);

  assert.deepEqual(s.addChannel(srv, 'Games Room'), { key: 'games-room' });
  assert.deepEqual(s.addChannel(srv, 'games room'), { error: 'CHANNEL_LIMIT' });

  const snap = s.buildServerState(srv);
  assert.equal(snap.hasPassword, true);
  assert.equal(snap.users[b.id].channelName, 'lobby');
  assert.ok(!('token' in snap.users[b.id]), 'tokens never leak into snapshots');
  assert.ok(!JSON.stringify(snap).includes(a.token));

  s.removeUser(a); s.removeUser(b);
  assert.equal(s.serverCount(), 1);
  const res = s.removeUser(c);
  assert.equal(res.serverDeleted, true);
  assert.equal(s.serverCount(), 0);
  assert.equal(s.removeUser(c).srv, null, 'removing twice is a no-op');
});

test('state: per-IP socket accounting', () => {
  const s = St.createState(loadConfig({ MAX_CONNECTIONS: '3', MAX_CONNECTIONS_PER_IP: '2' }));
  const w1 = {}, w2 = {}, w3 = {}, w4 = {};
  assert.equal(s.registerSocket(w1, 'a'), null);
  assert.equal(s.registerSocket(w2, 'a'), null);
  assert.equal(s.registerSocket(w3, 'a'), 'MAX_CONNECTIONS_PER_IP');
  assert.equal(s.registerSocket(w3, 'b'), null);
  assert.equal(s.registerSocket(w4, 'c'), 'MAX_CONNECTIONS');
  s.unregisterSocket(w1);
  assert.equal(s.registerSocket(w4, 'a'), null);
});

test('TURN secret can come from a file; direct value wins', () => {
  const files = { '/run/turn': 'from-file\n' };
  const readFile = (f) => { if (!(f in files)) { const e = new Error('nope'); e.code = 'ENOENT'; throw e; } return files[f]; };
  assert.equal(loadConfig({ TURN_SECRET_FILE: '/run/turn' }, { readFile }).ice.turnSecret, 'from-file');
  assert.equal(loadConfig({ TURN_SECRET: 'direct', TURN_SECRET_FILE: '/run/turn' }, { readFile }).ice.turnSecret, 'direct');
  assert.throws(() => loadConfig({ TURN_SECRET_FILE: '/missing' }, { readFile }), /TURN_SECRET_FILE.*\/missing.*ENOENT/);
});

test('a TURN secret alone enables relay on the page host and TURN_PORT', () => {
  const c = loadConfig({ TURN_SECRET: 's' });
  assert.equal(c.ice.relayAvailable, true);
  assert.deepEqual(c.ice.turnUrls, ['turn:{host}:3478?transport=udp', 'turn:{host}:3478?transport=tcp']);
  assert.deepEqual(loadConfig({ TURN_SECRET: 's', TURN_PORT: '5349' }).ice.turnUrls[0], 'turn:{host}:5349?transport=udp');
  assert.deepEqual(loadConfig({ TURN_SECRET: 's', TURN_URLS: '' }).ice.turnUrls.length, 2, 'empty TURN_URLS (compose default) keeps auto URLs');
  assert.deepEqual(loadConfig({ TURN_SECRET: 's', TURN_URLS: 'turns:t.example:443' }).ice.turnUrls, ['turns:t.example:443']);
});

test('turnHostFrom / {host} substitution', () => {
  const { turnHostFrom } = require('../../server/ice');
  assert.equal(turnHostFrom('Voice.Example.com:3111'), 'voice.example.com');
  assert.equal(turnHostFrom('[::1]:3000'), '[::1]');
  assert.equal(turnHostFrom('evil host"x'), null);
  assert.equal(turnHostFrom(undefined), null);
  const ice = loadConfig({ TURN_SECRET: 's', STUN_URLS: '' }).ice;
  assert.deepEqual(buildIceServers(ice, '1', Date.now(), 'v.example')[0].urls,
    ['turn:v.example:3478?transport=udp', 'turn:v.example:3478?transport=tcp']);
  assert.deepEqual(buildIceServers(ice, '1', Date.now(), null), [], 'no host → no unusable {host} URLs');
});
