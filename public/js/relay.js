// ── Audio relay via WebSocket (3+ users) ────────────────────────────────────
// Replaces WebRTC mesh+mixer with server-side relay.
// Each client sends Int16 PCM chunks; server broadcasts to other channel members.
// Each client plays incoming streams independently — no echo, no mixer graph.
//
// Depends on: audio.js, net.js

const RELAY_CHUNK_SIZE  = 512;  // 32ms of audio, must be power of 2 (256/512/1024/2048/4096/8192/16384)
let relaySampleRate = 44100;      // set from AudioContext at start

let relayActive = false;
let relaySource = null;
let relayProcessor = null;

// ── Per-peer playback queues ────────────────────────────────────────────────

const peerQueues    = new Map();  // peerId → { chunks: Float32Array[], scheduledEnd, playing }
const peerGains     = new Map();  // peerId → GainNode
const peerTimers    = new Map();  // peerId → speaking timeout ID
const _seenRelayChunks = new Set(); // track first-chunk logs

// ── Start / Stop ────────────────────────────────────────────────────────────

async function startRelay(myUserId) {
  if (relayActive) return;
  console.log('[relay] startRelay userId=' + myUserId);
  const local = getLocalStream();
  if (!local) return;

  const ctx = await ensureAudioRunning();
  relaySampleRate = ctx.sampleRate;
  relayActive = true;

  // Capture mic via ScriptProcessor
  relaySource = ctx.createMediaStreamSource(local);
  relayProcessor = ctx.createScriptProcessor(RELAY_CHUNK_SIZE, 1, 1);
  relaySource.connect(relayProcessor);

  // Connect to a silent GainNode — prevents browser from GC'ing/stopping
  // the processor node (some browsers optimize away dead-end graphs).
  // Zero gain prevents local echo.
  const silentGain = ctx.createGain();
  silentGain.gain.value = 0;
  relayProcessor.connect(silentGain);
  silentGain.connect(ctx.destination);

  relayProcessor.onaudioprocess = (e) => {
    if (!relayActive) return;
    try {
      const input = e.inputBuffer.getChannelData(0);

      // Float32 → Int16 PCM
      const pcm = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }

      // Header: [userId:4 LE][sampleRate:2 LE][Int16 PCM...]
      const buf = new ArrayBuffer(6 + pcm.byteLength);
      const view = new DataView(buf);
      view.setUint32(0, myUserId, true);
      view.setUint16(4, relaySampleRate, true);
      new Uint8Array(buf, 6).set(new Uint8Array(pcm.buffer));

      sendWsBinary(buf);
    } catch (err) {
      console.warn('[relay] capture error:', err);
    }
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
  if (data.byteLength < 7) return;  // userId(4) + sampleRate(2) + at least 1 sample

  const view = new DataView(data);
  const fromId = String(view.getUint32(0, true));
  const sampleRate = view.getUint16(4, true);
  const pcm = new Int16Array(data.slice(6));
  if (pcm.length === 0) return;
  if (!_seenRelayChunks.has(fromId)) {
    _seenRelayChunks.add(fromId);
    console.log('[relay] first chunk from peer ' + fromId + ' size=' + pcm.length + ' sr=' + sampleRate);
  }

  // Decode to Float32
  const float32 = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) float32[i] = pcm[i] / 32768;

  // Queue playback
  let queue = peerQueues.get(fromId);
  if (!queue) {
    queue = { chunks: [], scheduledEnd: 0, playing: false, sampleRate: sampleRate };
    peerQueues.set(fromId, queue);
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
    if (queue) {
      queue.playing = false;
      // Re-check after a short delay in case chunks arrived during playback
      if (queue._checkTimer) clearTimeout(queue._checkTimer);
      queue._checkTimer = setTimeout(() => {
        if (queue.chunks.length > 0) {
          queue.playing = true;
          playNextRelayChunk(fromId);
        }
      }, 80);
    }
    return;
  }

  const float32 = queue.chunks.shift();
  const ctx = getAudioContext();

  const buf = ctx.createBuffer(1, float32.length, queue.sampleRate);
  buf.getChannelData(0).set(float32);

  const source = ctx.createBufferSource();
  source.buffer = buf;
  source.connect(getOrCreatePeerGain(fromId));

  const now = ctx.currentTime;
  // If we've fallen behind (scheduledEnd is in the past), just play now.
  // If we're ahead, schedule at the end of the last chunk.
  const startTime = Math.max(now, queue.scheduledEnd);
  source.start(startTime);

  queue.scheduledEnd = startTime + float32.length / queue.sampleRate;

  // Schedule next chunk check just before this one ends
  const durationSec = float32.length / queue.sampleRate;
  setTimeout(() => playNextRelayChunk(fromId), (durationSec * 1000) - 5);
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
    peerQueues.set(peerId, { chunks: [], scheduledEnd: 0, playing: false, sampleRate: relaySampleRate });
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
