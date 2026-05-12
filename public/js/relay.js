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

// ── Start / Stop ────────────────────────────────────────────────────────────

async function startRelay(myUserId) {
  if (relayActive) return;
  const local = getLocalStream();
  if (!local) return;
  await ensureAudioRunning();
  relayActive = true;
  console.log('[relay] startRelay userId=' + myUserId);

  // Encode mic via MediaRecorder (Opus in WebM, ~32kbps voice quality)
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';
  relayRecorder = new MediaRecorder(local, { mimeType, audioBitsPerSecond: 32000 });

  relayRecorder.ondataavailable = (e) => {
    if (!relayActive || e.data.size === 0) return;
    const reader = new FileReader();
    reader.onload = () => {
      // Prepend 4-byte userId LE
      const blobData = new Uint8Array(reader.result);
      const buf = new ArrayBuffer(4 + blobData.byteLength);
      new DataView(buf).setUint32(0, myUserId, true);
      new Uint8Array(buf, 4).set(blobData);
      sendWsBinary(buf);
    };
    reader.readAsArrayBuffer(e.data);
  };

  relayRecorder.onerror = (e) => console.warn('[relay] recorder error:', e);
  relayRecorder.start(40); // 40ms chunks
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

  // Feed chunk into MediaSource
  if (peer.sourceBuffer && !peer.sourceBuffer.updating) {
    try {
      peer.sourceBuffer.appendBuffer(audioData);
    } catch (e) {
      console.warn('[relay] appendBuffer error for ' + fromId + ':', e);
    }
  } else if (peer.pending) {
    // SourceBuffer is updating — queue for later
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
  try {
    const mediaSource = new MediaSource();
    const audio = new Audio();
    audio.autoplay = true;
    audio.src = URL.createObjectURL(mediaSource);

    const peer = {
      audio,
      mediaSource,
      sourceBuffer: null,
      pending: []
    };

    mediaSource.onsourceopen = () => {
      try {
        const mimeType = MediaSource.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm';
        peer.sourceBuffer = mediaSource.addSourceBuffer(mimeType);
        peer.sourceBuffer.mode = 'sequence'; // sequential append mode

        peer.sourceBuffer.onupdateend = () => {
          // Feed next pending chunk
          if (peer.pending.length > 0) {
            try {
              peer.sourceBuffer.appendBuffer(peer.pending.shift());
            } catch (e) {
              console.warn('[relay] appendBuffer error:', e);
            }
          }
        };

        peer.sourceBuffer.onerror = (e) => {
          console.warn('[relay] sourceBuffer error for ' + peerId);
        };
      } catch (e) {
        console.warn('[relay] MediaSource setup failed for ' + peerId + ':', e);
      }
    };

    mediaSource.onerror = () => {
      console.warn('[relay] MediaSource error for ' + peerId);
    };

    audio.play().catch(() => {
      // Autoplay blocked — retry on click
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
