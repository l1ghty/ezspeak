// ── Audio relay via WebSocket (3+ users) ────────────────────────────────────
// Replaces WebRTC mesh+mixer with server-side relay.
// Each client sends Int16 PCM chunks; server broadcasts to other channel members.
// Each client plays incoming streams independently — no echo, no mixer graph.
//
// Depends on: audio.js, net.js

const RELAY_SAMPLE_RATE = 16000;
const RELAY_CHUNK_SIZE  = 640;  // 40ms of audio per chunk

let relayActive = false;
let relaySource = null;
let relayProcessor = null;

// ── Per-peer playback queues ────────────────────────────────────────────────

const peerQueues    = new Map();  // peerId → { chunks: Float32Array[], scheduledEnd, playing }
const peerGains     = new Map();  // peerId → GainNode
const peerTimers    = new Map();  // peerId → speaking timeout ID
const _seenRelayChunks = new Set(); // track first-chunk logs

// ── Start / Stop ────────────────────────────────────────────────────────────

function startRelay(myUserId) {
  if (relayActive) return;
  console.log('[relay] startRelay userId=' + myUserId);
  const local = getLocalStream();
  if (!local) return;

  const ctx = getAudioContext();
  relayActive = true;

  // Capture mic via ScriptProcessor
  relaySource = ctx.createMediaStreamSource(local);
  relayProcessor = ctx.createScriptProcessor(RELAY_CHUNK_SIZE, 1, 1);
  relaySource.connect(relayProcessor);
  // DON'T connect relayProcessor to destination — we don't want local echo

  relayProcessor.onaudioprocess = (e) => {
    if (!relayActive) return;
    const input = e.inputBuffer.getChannelData(0);

    // Float32 → Int16 PCM
    const pcm = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    // Prepend 4-byte userId (little-endian) so server can route
    const buf = new ArrayBuffer(4 + pcm.byteLength);
    new DataView(buf).setUint32(0, myUserId, true);
    new Uint8Array(buf, 4).set(new Uint8Array(pcm.buffer));

    sendWsBinary(buf);
  };

  // Mark all existing peers as connected (they'll start streaming via relay)
  for (const peerId of peerGains.keys()) {
    markPeerSpeaking(peerId, false);
  }
}

function stopRelay() {
  relayActive = false;
  try { if (relayProcessor) relayProcessor.disconnect(); } catch (e) {}
  relayProcessor = null;
  try { if (relaySource) relaySource.disconnect(); } catch (e) {}
  relaySource = null;
}

// ── Incoming chunk handler ──────────────────────────────────────────────────

function handleRelayChunk(data) {
  // Log first chunk only per peer to avoid spam
  if (!(data instanceof ArrayBuffer)) return;
  if (data.byteLength < 5) return;

  const view = new DataView(data);
  const fromId = String(view.getUint32(0, true));
  if (!_seenRelayChunks.has(fromId)) {
    _seenRelayChunks.add(fromId);
    console.log('[relay] first chunk from peer ' + fromId + ' size=' + pcm.length + 'samples');
  }
  const pcm = new Int16Array(data.slice(4));
  if (pcm.length === 0) return;

  // Decode to Float32
  const float32 = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) float32[i] = pcm[i] / 32768;

  // Queue playback
  let queue = peerQueues.get(fromId);
  if (!queue) {
    queue = { chunks: [], scheduledEnd: 0, playing: false };
    peerQueues.set(fromId, queue);
    // Ensure a gain node exists
    getOrCreatePeerGain(fromId);
  }
  queue.chunks.push(float32);
  if (!queue.playing) {
    queue.playing = true;
    playNextRelayChunk(fromId);
  }

  // Speaking indicator
  markPeerSpeaking(fromId, true);
  clearTimeout(peerTimers.get(fromId));
  peerTimers.set(fromId, setTimeout(() => markPeerSpeaking(fromId, false), 600));
}

// ── Chunk player ────────────────────────────────────────────────────────────

function playNextRelayChunk(fromId) {
  const queue = peerQueues.get(fromId);
  if (!queue || queue.chunks.length === 0) {
    if (queue) queue.playing = false;
    return;
  }

  const float32 = queue.chunks.shift();
  const ctx = getAudioContext();

  const buf = ctx.createBuffer(1, float32.length, RELAY_SAMPLE_RATE);
  buf.getChannelData(0).set(float32);

  const source = ctx.createBufferSource();
  source.buffer = buf;
  source.connect(getOrCreatePeerGain(fromId));

  const now = ctx.currentTime;
  const startTime = queue.scheduledEnd > 0 ? Math.max(now, queue.scheduledEnd) : now;
  source.start(startTime);

  queue.scheduledEnd = startTime + float32.length / RELAY_SAMPLE_RATE;
  source.onended = () => playNextRelayChunk(fromId);
}

function getOrCreatePeerGain(fromId) {
  let gain = peerGains.get(fromId);
  if (!gain) {
    const ctx = getAudioContext();
    gain = ctx.createGain();
    gain.gain.value = 1.0;
    gain.connect(ctx.destination);
    peerGains.set(fromId, gain);
  }
  return gain;
}

// ── Deafened state ──────────────────────────────────────────────────────────

function setRelayDeafened(deafened) {
  for (const [peerId, gain] of peerGains) {
    gain.gain.value = deafened ? 0 : 1;
  }
}

// ── Peers joining/leaving ───────────────────────────────────────────────────

function addRelayPeer(peerId) {
  getOrCreatePeerGain(peerId);
  if (!peerQueues.has(peerId)) {
    peerQueues.set(peerId, { chunks: [], scheduledEnd: 0, playing: false });
  }
}

function removeRelayPeer(peerId) {
  clearTimeout(peerTimers.get(peerId));
  peerTimers.delete(peerId);

  const gain = peerGains.get(peerId);
  if (gain) { try { gain.disconnect(); } catch (e) {} }
  peerGains.delete(peerId);
  peerQueues.delete(peerId);
  markPeerSpeaking(peerId, false);
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

function cleanupRelay() {
  stopRelay();
  for (const [id, t] of peerTimers) clearTimeout(t);
  peerTimers.clear();
  for (const [id, gain] of peerGains) { try { gain.disconnect(); } catch (e) {} }
  peerGains.clear();
  peerQueues.clear();
}
