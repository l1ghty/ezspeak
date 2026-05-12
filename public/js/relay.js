// ── Audio relay via WebSocket (3+ users) ────────────────────────────────────
// Uses MediaRecorder (Opus in WebM) to encode mic, sends chunks via WebSocket.
// Server relays to other channel members.
// Receiver uses MediaSource to decode and play continuously per peer.
// No PCM encoding/decoding, no manual scheduling — browser handles all audio.

const relayPeers = new Map();  // peerId → { audio, mediaSource, sourceBuffer, pending: ArrayBuffer[] }
const relayTimers = new Map(); // peerId → speaking timeout
let relayRecorder = null;
let relayActive = false;

const _seenRelayPeers = new Set();

// Check MediaSource support at load time
const OPUS_MIME = MediaSource && MediaSource.isTypeSupported('audio/webm;codecs=opus')
  ? 'audio/webm;codecs=opus' : 'audio/webm';

// ── Start / Stop ────────────────────────────────────────────────────────────

async function startRelay(myUserId) {
  if (relayActive) return;
  const local = getLocalStream();
  if (!local) return;
  await ensureAudioRunning();
  relayActive = true;
  console.log('[relay] startRelay userId=' + myUserId);

  const mimeType = MediaRecorder.isTypeSupported(OPUS_MIME) ? OPUS_MIME : 'audio/webm';
  relayRecorder = new MediaRecorder(local, { mimeType, audioBitsPerSecond: 32000 });

  relayRecorder.ondataavailable = (e) => {
    if (!relayActive || e.data.size === 0) return;
    const reader = new FileReader();
    reader.onload = () => {
      const blobData = new Uint8Array(reader.result);
      const buf = new ArrayBuffer(4 + blobData.byteLength);
      new DataView(buf).setUint32(0, myUserId, true);
      new Uint8Array(buf, 4).set(blobData);
      sendWsBinary(buf);
    };
    reader.readAsArrayBuffer(e.data);
  };

  relayRecorder.onerror = (e) => console.warn('[relay] recorder error:', e);
  relayRecorder.start(40);
}

function stopRelay() {
  relayActive = false;
  if (relayRecorder && relayRecorder.state !== 'inactive') {
    try { relayRecorder.stop(); } catch (e) {}
  }
  relayRecorder = null;
}

// ── Incoming chunk handler ──────────────────────────────────────────────────

function handleRelayChunk(data) {
  if (!(data instanceof ArrayBuffer)) return;
  if (data.byteLength < 5) return;

  const view = new DataView(data);
  const fromId = String(view.getUint32(0, true));
  const audioData = data.slice(4);

  let peer = relayPeers.get(fromId);
  if (!peer) {
    peer = createRelayPeer(fromId);
    if (!peer) return;
  }

  // Skip tiny chunks (Opus DTX silence frames — not valid WebM)
  if (audioData.byteLength < 3) return;

  // Feed chunk into MediaSource
  if (peer.sourceBuffer) {
    if (!peer.sourceBuffer.updating) {
      try {
        peer.sourceBuffer.appendBuffer(audioData);
      } catch (e) {
        // sourceBuffer might be in error state — recreate
        console.warn('[relay] appendBuffer error for ' + fromId + ':', e.message);
        recreateRelayPeer(fromId);
      }
    } else {
      peer.pending.push(audioData);
    }
  } else if (peer.mediaSource && peer.mediaSource.readyState === 'open') {
    // SourceBuffer wasn't created yet — try now
    tryCreateSourceBuffer(peer, fromId);
    peer.pending.push(audioData);
    drainPending(peer);
  } else {
    // MediaSource not ready yet — queue
    peer.pending.push(audioData);
  }

  // Speaking indicator
  if (!_seenRelayPeers.has(fromId)) {
    _seenRelayPeers.add(fromId);
    console.log('[relay] first chunk from peer ' + fromId + ' (' + audioData.byteLength + ' bytes)');
  }
  markPeerSpeaking(fromId, true);
  clearTimeout(relayTimers.get(fromId));
  relayTimers.set(fromId, setTimeout(() => markPeerSpeaking(fromId, false), 800));
}

function createRelayPeer(peerId) {
  if (typeof MediaSource === 'undefined') {
    console.warn('[relay] MediaSource not supported in this browser');
    return null;
  }

  try {
    const mediaSource = new MediaSource();
    const audio = new Audio();
    audio.autoplay = true;

    const peer = {
      audio,
      mediaSource,
      sourceBuffer: null,
      pending: []
    };

    // Set up sourceopen BEFORE setting src to avoid race
    mediaSource.addEventListener('sourceopen', () => {
      tryCreateSourceBuffer(peer, peerId);
    }, { once: true });

    mediaSource.addEventListener('sourceended', () => {
      console.warn('[relay] MediaSource ended for ' + peerId);
    });

    mediaSource.addEventListener('error', () => {
      console.warn('[relay] MediaSource error for ' + peerId);
    });

    // Setting src triggers sourceopen (async)
    audio.src = URL.createObjectURL(mediaSource);
    audio.play().catch(() => {
      const retry = () => {
        if (audio.src) audio.play().catch(() => {});
        document.removeEventListener('click', retry);
        document.removeEventListener('touchstart', retry);
      };
      document.addEventListener('click', retry, { once: true });
      document.addEventListener('touchstart', retry, { once: true });
    });

    relayPeers.set(peerId, peer);
    return peer;
  } catch (e) {
    console.warn('[relay] createRelayPeer failed for ' + peerId + ':', e);
    return null;
  }
}

function tryCreateSourceBuffer(peer, peerId) {
  if (peer.sourceBuffer) return;
  if (!peer.mediaSource || peer.mediaSource.readyState !== 'open') return;

  try {
    peer.sourceBuffer = peer.mediaSource.addSourceBuffer(OPUS_MIME);
    peer.sourceBuffer.mode = 'sequence';

    peer.sourceBuffer.addEventListener('updateend', () => {
      drainPending(peer);
    });

    peer.sourceBuffer.addEventListener('error', () => {
      console.warn('[relay] sourceBuffer error for ' + peerId);
    });

    // Feed any pending chunks
    drainPending(peer);
  } catch (e) {
    console.warn('[relay] addSourceBuffer failed for ' + peerId + ':', e.message);
  }
}

function drainPending(peer) {
  while (peer.sourceBuffer && !peer.sourceBuffer.updating && peer.pending.length > 0) {
    const chunk = peer.pending.shift();
    if (chunk.byteLength >= 3) {
      try {
        peer.sourceBuffer.appendBuffer(chunk);
      } catch (e) {
        console.warn('[relay] drainPending appendBuffer error:', e.message);
        break;
      }
    }
  }
}

function recreateRelayPeer(peerId) {
  // Tear down old peer and create fresh
  removeRelayPeer(peerId);
  const peer = createRelayPeer(peerId);
  if (peer) relayPeers.set(peerId, peer);
}

// ── Peers joining/leaving ───────────────────────────────────────────────────

function addRelayPeer(peerId) {
  if (!relayPeers.has(peerId)) {
    createRelayPeer(peerId);
  }
}

function removeRelayPeer(peerId) {
  clearTimeout(relayTimers.get(peerId));
  relayTimers.delete(peerId);

  const peer = relayPeers.get(peerId);
  if (peer) {
    try { peer.audio.pause(); peer.audio.src = ''; peer.audio.remove(); } catch (e) {}
    relayPeers.delete(peerId);
  }
  _seenRelayPeers.delete(peerId);
  markPeerSpeaking(peerId, false);
}

// ── Deafened state ──────────────────────────────────────────────────────────

function setRelayDeafened(deafened) {
  for (const [peerId, peer] of relayPeers) {
    peer.audio.muted = deafened;
    if (!deafened) peer.audio.play().catch(() => {});
  }
}

// Called by audio.js autoplay recovery
function retryAllRelayAudio() {
  for (const [peerId, peer] of relayPeers) {
    if (!peer.audio.muted) peer.audio.play().catch(() => {});
  }
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

function cleanupRelay() {
  stopRelay();
  for (const [id, t] of relayTimers) clearTimeout(t);
  relayTimers.clear();
  for (const [id, peer] of relayPeers) {
    try { peer.audio.pause(); peer.audio.src = ''; peer.audio.remove(); } catch (e) {}
  }
  relayPeers.clear();
  _seenRelayPeers.clear();
}
