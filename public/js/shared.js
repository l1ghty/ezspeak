// ── Shared pure helpers (browser + Node) ────────────────────────────────────
// No DOM, no globals touched. Loaded as a classic <script> in the browser
// (functions become globals) and via require() on the server / in tests.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof self !== 'undefined' ? self : this, function () {

  // ── ICE candidate / SDP privacy filtering ────────────────────────────────

  // Returns the candidate type ('host' | 'srflx' | 'prflx' | 'relay') or null.
  function candidateType(candidateStr) {
    if (typeof candidateStr !== 'string') return null;
    const m = candidateStr.match(/\btyp\s+(host|srflx|prflx|relay)\b/);
    return m ? m[1] : null;
  }

  function isRelayCandidate(candidateStr) {
    return candidateType(candidateStr) === 'relay';
  }

  // Returns a privacy-safe version of a candidate line, or null when the
  // candidate must not be shared at all. Only TURN relay candidates survive,
  // and their related address (raddr — the user's reflexive/public IP) is
  // blanked out.
  function sanitizeCandidate(candidateStr) {
    if (!isRelayCandidate(candidateStr)) return null;
    return candidateStr
      .replace(/\braddr\s+\S+/, 'raddr 0.0.0.0')
      .replace(/\brport\s+\d+/, 'rport 0');
  }

  // Remove every ICE candidate that is not a TURN relay candidate and blank
  // out connection addresses, so an SDP never reveals a peer's own IP.
  function stripNonRelayFromSdp(sdp) {
    if (typeof sdp !== 'string') return sdp;
    const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
    return sdp
      .split(/\r?\n/)
      .filter(line => !(line.startsWith('a=candidate:') && !isRelayCandidate(line)))
      .map(line => {
        if (line.startsWith('a=candidate:')) return sanitizeCandidate(line);
        if (/^c=IN IP4 /.test(line)) return 'c=IN IP4 0.0.0.0';
        if (/^c=IN IP6 /.test(line)) return 'c=IN IP6 ::';
        if (/^a=rtcp:\d+ IN IP4 /.test(line)) return line.replace(/IN IP4 \S+/, 'IN IP4 0.0.0.0');
        if (/^a=rtcp:\d+ IN IP6 /.test(line)) return line.replace(/IN IP6 \S+/, 'IN IP6 ::');
        return line;
      })
      .join(eol);
  }

  // ── RTC configuration ────────────────────────────────────────────────────

  function hasTurnServer(iceServers) {
    if (!Array.isArray(iceServers)) return false;
    return iceServers.some(s => {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      return urls.some(u => typeof u === 'string' && /^turns?:/.test(u));
    });
  }

  function buildRtcConfig(iceServers, relayOnly) {
    return {
      iceServers: Array.isArray(iceServers) ? iceServers : [],
      iceTransportPolicy: relayOnly ? 'relay' : 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    };
  }

  // ── Connection negotiation decisions ─────────────────────────────────────

  // Random, sortable-enough id for one RTCPeerConnection "session".
  function newConnId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /**
   * Decide what to do with an incoming offer.
   *  current: null | { connId, isInitiator, connected }
   *  incomingConnId: connId carried by the offer
   * Returns:
   *  'create'      – no connection yet, accept as answerer
   *  'renegotiate' – same session, apply on the existing connection
   *  'replace'     – peer started a new session; drop ours and accept theirs
   *  'ignore'      – we are simultaneously starting our own session and ours
   *                  wins the deterministic tie-break (higher connId)
   */
  function decideOffer(current, incomingConnId) {
    if (!current) return 'create';
    if (current.connId === incomingConnId) return 'renegotiate';
    if (current.isInitiator && !current.connected && current.connId > incomingConnId) return 'ignore';
    return 'replace';
  }

  // Deterministic choice of who (re)starts a connection when both sides
  // learn about each other at the same time.
  function isPreferredInitiator(myId, peerId) {
    const a = Number(myId), b = Number(peerId);
    if (Number.isFinite(a) && Number.isFinite(b)) return a < b;
    return String(myId) < String(peerId);
  }

  // ── Misc ────────────────────────────────────────────────────────────────

  // Exponential slider curve for perceptually natural volume control.
  function sliderToAudioVolume(sliderVal) {
    const v = Number(sliderVal);
    if (!Number.isFinite(v)) return 1;
    const norm = Math.max(0, Math.min(v, 100)) / 100;
    return Math.pow(norm, 1.5);
  }

  // Exponential backoff with ±20 % jitter. `rand` injectable for tests.
  function reconnectDelay(attempt, base = 1000, max = 15000, rand = Math.random) {
    const delay = Math.min(base * Math.pow(2, Math.max(0, attempt - 1)), max);
    const jitter = delay * 0.2 * (rand() * 2 - 1);
    return Math.max(0, Math.round(delay + jitter));
  }

  function normalizeServerName(name) {
    if (typeof name !== 'string') return '';
    return name.trim().toLowerCase().replace(/\s+/g, '-');
  }

  return {
    candidateType, isRelayCandidate, sanitizeCandidate, stripNonRelayFromSdp,
    hasTurnServer, buildRtcConfig,
    newConnId, decideOffer, isPreferredInitiator,
    sliderToAudioVolume, reconnectDelay, normalizeServerName,
  };
});
