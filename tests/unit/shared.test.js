const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../public/js/shared');

const HOST = 'candidate:1 1 udp 2122260223 192.168.1.20 54321 typ host generation 0';
const MDNS = 'candidate:2 1 udp 2122260223 4f1c-uuid.local 54321 typ host generation 0';
const SRFLX = 'candidate:3 1 udp 1686052607 203.0.113.7 40000 typ srflx raddr 192.168.1.20 rport 54321';
const RELAY = 'candidate:4 1 udp 41885439 198.51.100.9 50000 typ relay raddr 203.0.113.7 rport 40000';

test('candidateType parses candidate types', () => {
  assert.equal(S.candidateType(HOST), 'host');
  assert.equal(S.candidateType(MDNS), 'host');
  assert.equal(S.candidateType(SRFLX), 'srflx');
  assert.equal(S.candidateType(RELAY), 'relay');
  assert.equal(S.candidateType(''), null);
  assert.equal(S.candidateType(undefined), null);
  assert.equal(S.isRelayCandidate(RELAY), true);
  assert.equal(S.isRelayCandidate(SRFLX), false);
});

test('stripNonRelayFromSdp removes every non-relay address', () => {
  const sdp = [
    'v=0',
    'o=- 123 2 IN IP4 127.0.0.1',
    'm=audio 54321 UDP/TLS/RTP/SAVPF 111',
    'c=IN IP4 203.0.113.7',
    'a=rtcp:9 IN IP4 192.168.1.20',
    'a=' + HOST,
    'a=' + SRFLX,
    'a=' + RELAY,
    'a=' + MDNS,
    'c=IN IP6 2001:db8::1',
    '',
  ].join('\r\n');
  const out = S.stripNonRelayFromSdp(sdp);
  assert.ok(!out.includes('192.168.1.20 54321 typ host'));
  assert.ok(!out.includes('typ srflx'));
  assert.ok(!out.includes('.local'));
  assert.ok(out.includes('typ relay'));
  assert.ok(out.includes('c=IN IP4 0.0.0.0'));
  assert.ok(out.includes('c=IN IP6 ::'));
  assert.ok(out.includes('a=rtcp:9 IN IP4 0.0.0.0'));
  assert.ok(!out.includes('2001:db8::1'));
  assert.ok(out.includes('\r\n'), 'keeps CRLF line endings');
  assert.ok(!out.includes('203.0.113.7'), 'public IP in relay raddr is scrubbed');
  assert.ok(out.includes('198.51.100.9 50000 typ relay raddr 0.0.0.0 rport 0'));
  assert.equal(S.stripNonRelayFromSdp(42), 42);
});

test('sanitizeCandidate keeps relay only and scrubs raddr', () => {
  assert.equal(S.sanitizeCandidate(HOST), null);
  assert.equal(S.sanitizeCandidate(SRFLX), null);
  assert.equal(S.sanitizeCandidate(MDNS), null);
  assert.equal(S.sanitizeCandidate(RELAY),
    'candidate:4 1 udp 41885439 198.51.100.9 50000 typ relay raddr 0.0.0.0 rport 0');
  const noRaddr = 'candidate:5 1 udp 1 198.51.100.9 50000 typ relay';
  assert.equal(S.sanitizeCandidate(noRaddr), noRaddr);
});

test('hasTurnServer / buildRtcConfig', () => {
  assert.equal(S.hasTurnServer([{ urls: 'stun:x' }]), false);
  assert.equal(S.hasTurnServer([{ urls: ['stun:x', 'turn:y:3478'] }]), true);
  assert.equal(S.hasTurnServer([{ urls: 'turns:y:5349' }]), true);
  assert.equal(S.hasTurnServer(null), false);
  assert.equal(S.buildRtcConfig([], true).iceTransportPolicy, 'relay');
  assert.equal(S.buildRtcConfig(undefined, false).iceTransportPolicy, 'all');
  assert.deepEqual(S.buildRtcConfig(undefined, false).iceServers, []);
});

test('decideOffer handles create / renegotiate / replace / glare', () => {
  assert.equal(S.decideOffer(null, 'a'), 'create');
  assert.equal(S.decideOffer({ connId: 'a', isInitiator: true, connected: true }, 'a'), 'renegotiate');
  // Peer restarted (e.g. page reload) while we think we're connected
  assert.equal(S.decideOffer({ connId: 'a', isInitiator: true, connected: true }, 'b'), 'replace');
  assert.equal(S.decideOffer({ connId: 'a', isInitiator: false, connected: false }, 'b'), 'replace');
  // Both sides started a fresh session simultaneously: higher connId wins on both sides
  const x = 'k-111', y = 'k-222';
  const aSees = S.decideOffer({ connId: x, isInitiator: true, connected: false }, y);
  const bSees = S.decideOffer({ connId: y, isInitiator: true, connected: false }, x);
  assert.equal(aSees, 'replace');
  assert.equal(bSees, 'ignore');
});

test('isPreferredInitiator is antisymmetric and numeric-aware', () => {
  assert.equal(S.isPreferredInitiator('2', '10'), true);
  assert.equal(S.isPreferredInitiator('10', '2'), false);
  assert.equal(S.isPreferredInitiator('a', 'b'), true);
  assert.equal(S.isPreferredInitiator('b', 'a'), false);
});

test('newConnId is unique-ish', () => {
  const ids = new Set(Array.from({ length: 200 }, S.newConnId));
  assert.equal(ids.size, 200);
});

test('sliderToAudioVolume clamps and curves', () => {
  assert.equal(S.sliderToAudioVolume(0), 0);
  assert.equal(S.sliderToAudioVolume(100), 1);
  assert.equal(S.sliderToAudioVolume(250), 1);
  assert.equal(S.sliderToAudioVolume(-5), 0);
  assert.equal(S.sliderToAudioVolume('x'), 1);
  assert.ok(Math.abs(S.sliderToAudioVolume(50) - Math.pow(0.5, 1.5)) < 1e-9);
});

test('reconnectDelay grows exponentially and is capped', () => {
  const mid = () => 0.5; // zero jitter
  assert.equal(S.reconnectDelay(1, 1000, 15000, mid), 1000);
  assert.equal(S.reconnectDelay(2, 1000, 15000, mid), 2000);
  assert.equal(S.reconnectDelay(4, 1000, 15000, mid), 8000);
  assert.equal(S.reconnectDelay(10, 1000, 15000, mid), 15000);
  assert.equal(S.reconnectDelay(1, 1000, 15000, () => 1), 1200);
  assert.equal(S.reconnectDelay(1, 1000, 15000, () => 0), 800);
});

test('normalizeServerName', () => {
  assert.equal(S.normalizeServerName('  My  Crew '), 'my-crew');
  assert.equal(S.normalizeServerName(null), '');
});
