// ── WebRTC full mesh ───────────────────────────────────────────────────────
// Direct P2P audio between all peers in a channel (2+ users).
// Each client connects to every other client.  Browsers natively mix
// multiple <audio> elements — no custom mixer needed.
//
// Depends on: config.js, audio.js, net.js (sendWs)

const peerConnections = new Map();    // peerId → RTCPeerConnection
const remoteAudios = new Map();       // peerId → HTMLAudioElement
const pendingCandidates = new Map();  // peerId → RTCIceCandidate[]

// ── Per-user volume / mute ─────────────────────────────────────────────────
// Uses audio.volume with exponential slider mapping for full perceptual range.

const userVolume = new Map();  // peerId → slider value (0-200)
const userMuted  = new Map();  // peerId → boolean

function sliderToAudioVolume(sliderVal) {
  // Map slider 0-200 to audio.volume 0-1 with exponential curve.
  // Slider at 100 = unity (1.0). Slider at 50 ≈ perceived half volume.
  const norm = Math.max(0, Math.min(sliderVal, 100) / 100);
  return Math.pow(norm, 1.5);
}

function setPeerVolume(peerId, sliderVal) {
  userVolume.set(peerId, sliderVal);
  applyPeerAudioState(peerId);
}

function getPeerVolume(peerId) {
  return userVolume.get(peerId) ?? 100;
}

function togglePeerMute(peerId) {
  const cur = userMuted.get(peerId) || false;
  userMuted.set(peerId, !cur);
  applyPeerAudioState(peerId);
  return !cur;
}

function isPeerMutedLocally(peerId) {
  return userMuted.get(peerId) || false;
}

function applyPeerAudioState(peerId) {
  const audio = remoteAudios.get(peerId);
  if (!audio) return;
  const muted = isDeafened || (userMuted.get(peerId) || false);
  audio.muted = muted;
  audio.volume = sliderToAudioVolume(userVolume.get(peerId) ?? 100);
  if (!muted) audio.play().catch(() => {});
}

// ── Audio element mute control (called by audio.js) ─────────────────────────

function updateRemoteAudioMutes(deafened) {
  // Update all peers using applyPeerAudioState to respect per-user mute
  for (const peerId of remoteAudios.keys()) {
    applyPeerAudioState(peerId);
  }
}

// Called by audio.js on first user interaction (recovers from autoplay block)
function retryAllRemoteAudio() {
  remoteAudios.forEach(a => {
    if (!a.muted) a.play().catch(() => {});
  });
}

// ── Peer connection ─────────────────────────────────────────────────────────

function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection(RTC_CONFIG);

  pc.onicecandidate = (e) => {
    if (e.candidate) sendWs({ type: 'webrtc-ice-candidate', targetId: peerId, candidate: e.candidate });
  };

  pc.ontrack = (e) => {
    if (e.streams && e.streams[0]) addRemoteStream(peerId, e.streams[0]);
  };

  pc.ondatachannel = (e) => {
    onDataChannel(peerId, e.channel);
  };

  pc.oniceconnectionstatechange = () => {
    if (['disconnected', 'failed', 'closed'].includes(pc.iceConnectionState)) {
      closePeerConnection(peerId);
    }
  };

  peerConnections.set(peerId, pc);
  return pc;
}

function attachLocalTracks(pc) {
  const stream = getLocalStream();
  if (!stream) return;
  stream.getTracks().forEach(track => pc.addTrack(track, stream));
}

function addRemoteStream(peerId, stream) {
  console.log('[webrtc] addRemoteStream peer=' + peerId + ' tracks=' + (stream?.getAudioTracks().length || 0));
  if (remoteAudios.has(peerId)) {
    remoteAudios.get(peerId).srcObject = null;
    remoteAudios.get(peerId).remove();
  }
  const audio = new Audio();
  audio.srcObject = stream;
  audio.autoplay = true;
  remoteAudios.set(peerId, audio);
  applyPeerAudioState(peerId);
  audio.play().then(() => console.log('[webrtc] audio playing for ' + peerId)).catch(() => {
    console.warn('[webrtc] autoplay blocked for ' + peerId + ' — will retry on click');
    const retry = () => {
      if (!audio.srcObject) return;
      audio.play().catch(() => {});
      document.removeEventListener('click', retry);
      document.removeEventListener('touchstart', retry);
    };
    document.addEventListener('click', retry, { once: true });
    document.addEventListener('touchstart', retry, { once: true });
  });
  remoteAudios.set(peerId, audio);
  startSpeakingDetection(peerId, stream, false);
  refreshUserList();
}

// ── Initiating connections ─────────────────────────────────────────────────

async function initiateWebRTC(peerId) {
  console.log('[webrtc] initiateWebRTC to ' + peerId);
  await ensureLocalStream();
  const pc = createPeerConnection(peerId);
  attachLocalTracks(pc);
  // Create data channel for file transfer
  createDataChannel(peerId);
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendWs({ type: 'webrtc-offer', targetId: peerId, offer });
  } catch (err) { console.error('Error creating offer:', err); closePeerConnection(peerId); }
}

// ── Handling incoming signaling ─────────────────────────────────────────────

async function handleOffer(fromId, offer) {
  console.log('[webrtc] handleOffer from ' + fromId);
  await ensureLocalStream();
  const pc = createPeerConnection(fromId);
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    attachLocalTracks(pc);
    // Create data channel if offerer didn't (but offerer should have)
    if (!fileChannels.has(fromId)) createDataChannel(fromId);
    if (pendingCandidates.has(fromId)) {
      for (const c of pendingCandidates.get(fromId)) await pc.addIceCandidate(new RTCIceCandidate(c));
      pendingCandidates.delete(fromId);
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendWs({ type: 'webrtc-answer', targetId: fromId, answer });
  } catch (err) { console.error('Error handling offer:', err); closePeerConnection(fromId); }
}

async function handleAnswer(fromId, answer) {
  const pc = peerConnections.get(fromId);
  if (pc) {
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      if (pendingCandidates.has(fromId)) {
        for (const c of pendingCandidates.get(fromId)) await pc.addIceCandidate(new RTCIceCandidate(c));
        pendingCandidates.delete(fromId);
      }
    } catch (err) { console.error('Error handling answer:', err); closePeerConnection(fromId); }
  }
}

async function handleIceCandidate(fromId, candidate) {
  const pc = peerConnections.get(fromId);
  if (pc && pc.remoteDescription) {
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (err) { console.error('ICE error:', err); }
  } else {
    if (!pendingCandidates.has(fromId)) pendingCandidates.set(fromId, []);
    pendingCandidates.get(fromId).push(candidate);
  }
}


// ── P2P File Transfer (DataChannel) ───────────────────────────────────────
// Inspired by file.pizza — metadata shown instantly, transfer on click.
// Sender announces file via WebSocket → receiver clicks Download → chunks flow.

const fileChannels = new Map();       // peerId → RTCDataChannel
const pendingFiles = new Map();       // fileId → { name, size, mimeType, chunks: Map, fromPeer, fromName }
const fileBlobs = new Map();         // fileId → File (held by sender until requested)
const CHUNK_SIZE = 16384;            // 16 KB per chunk
let _onFileReceived = null;          // callback(peerId, peerName, fileName, blob, size, fileId, isOutgoing)

function onFileReceived(fn) { _onFileReceived = fn; }

function createDataChannel(peerId) {
  const pc = peerConnections.get(peerId);
  if (!pc || fileChannels.has(peerId)) return;
  try {
    const channel = pc.createDataChannel('filetransfer');
    setupDataChannel(peerId, channel);
    fileChannels.set(peerId, channel);
  } catch (e) { console.warn('[file] createDataChannel failed:', e); }
}

function setupDataChannel(peerId, channel) {
  channel.binaryType = 'arraybuffer';

  channel.onopen = () => {};

  channel.onmessage = (e) => {
    if (typeof e.data === 'string') {
      try {
        const msg = JSON.parse(e.data);
        if (msg.t === 'request') {
          const blob = fileBlobs.get(msg.id);
          if (blob) sendFileChunks(peerId, blob, msg.id);
        }
      } catch (_) {}
      return;
    }
    handleFileChunk(peerId, e.data);
  };

  channel.onerror = () => {};
  channel.onclose = () => { fileChannels.delete(peerId); };
}

function onDataChannel(peerId, channel) {
  if (channel.label === 'filetransfer') {
    setupDataChannel(peerId, channel);
    fileChannels.set(peerId, channel);
  }
}

// ── Announce file (via WebSocket — instant, no reading) ────────────────────

function announceFile(file) {
  const fileId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  fileBlobs.set(fileId, file);
  sendWs({
    type: 'file-announce',
    fileId,
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type
  });
  // Show in own chat
  if (_onFileReceived) {
    _onFileReceived(userId, 'You', file.name, null, file.size, fileId, true);
  }
}

// ── Request file (receiver clicks Download) ────────────────────────────────

function requestFile(peerId, fileId) {
  const channel = fileChannels.get(peerId);
  if (!channel || channel.readyState !== 'open') {
    if (!channel) createDataChannel(peerId);
    const ch = fileChannels.get(peerId);
    if (ch) ch.addEventListener('open', () => requestFile(peerId, fileId), { once: true });
    return;
  }
  // Create pending entry to receive chunks
  if (!pendingFiles.has(fileId)) {
    pendingFiles.set(fileId, {
      name: '', size: 0, mimeType: '', chunks: new Map(), fromPeer: peerId, fromName: ''
    });
  }
  channel.send(JSON.stringify({ t: 'request', id: fileId }));
}

// ── Send file chunks (sender side, on request) ─────────────────────────────

function sendFileChunks(peerId, file, fileId) {
  const channel = fileChannels.get(peerId);
  if (!channel || channel.readyState !== 'open') {
    const ch = fileChannels.get(peerId);
    if (ch) ch.addEventListener('open', () => sendFileChunks(peerId, file, fileId), { once: true });
    return;
  }

  console.log('[file] sending ' + file.name + ' (' + file.size + ' bytes) to ' + peerId);

  const reader = new FileReader();
  let offset = 0;

  reader.onload = () => {
    const data = reader.result;
    const idx = Math.floor(offset / CHUNK_SIZE);
    const header = new ArrayBuffer(9);
    const view = new DataView(header);
    view.setUint8(0, 0x43);
    view.setUint32(1, idx, true);
    view.setUint32(5, hashFileId(fileId), true);

    const chunkBuf = new Uint8Array(header.byteLength + data.byteLength);
    chunkBuf.set(new Uint8Array(header), 0);
    chunkBuf.set(new Uint8Array(data), header.byteLength);
    channel.send(chunkBuf.buffer);

    offset += CHUNK_SIZE;
    if (offset < file.size) readNext();
    else sendFileComplete(channel, fileId);
  };

  function readNext() {
    const slice = file.slice(offset, offset + CHUNK_SIZE);
    reader.readAsArrayBuffer(slice);
  }
  readNext();
}

function sendFileComplete(channel, fileId) {
  const buf = new ArrayBuffer(9);
  const view = new DataView(buf);
  view.setUint8(0, 0x45);
  view.setUint32(1, hashFileId(fileId), true);
  channel.send(buf);
}

function hashFileId(fileId) {
  let h = 0;
  for (let i = 0; i < fileId.length; i++) h = ((h << 5) - h + fileId.charCodeAt(i)) | 0;
  return h >>> 0;
}

// ── Receive file chunks ────────────────────────────────────────────────────

function handleFileChunk(peerId, data) {
  if (!(data instanceof ArrayBuffer)) return;
  const view = new DataView(data);
  const type = view.getUint8(0);

  if (type === 0x43) {
    const chunkIdx = view.getUint32(1, true);
    const fileIdHash = view.getUint32(5, true);
    for (const [fileId, info] of pendingFiles) {
      if (hashFileId(fileId) === fileIdHash && info.fromPeer === peerId) {
        info.chunks.set(chunkIdx, new Uint8Array(data.slice(9)));
        return;
      }
    }
  } else if (type === 0x45) {
    const fileIdHash = view.getUint32(1, true);
    for (const [fileId, info] of pendingFiles) {
      if (hashFileId(fileId) === fileIdHash && info.fromPeer === peerId) {
        const totalSize = info.size;
        const result = new Uint8Array(totalSize);
        let written = 0;
        for (let i = 0; i < info.chunks.size; i++) {
          const chunk = info.chunks.get(i);
          if (chunk) { result.set(chunk, written); written += chunk.byteLength; }
        }
        const blob = new Blob([result], { type: info.mimeType || 'application/octet-stream' });
        console.log('[file] received ' + info.name + ' (' + blob.size + ') from ' + info.fromName);
        pendingFiles.delete(fileId);
        // Auto-download
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = info.name;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        return;
      }
    }
  }
}
// ── Cleanup ─────────────────────────────────────────────────────────────────

function closePeerConnection(peerId) {
  const pc = peerConnections.get(peerId);
  if (pc) { pc.close(); peerConnections.delete(peerId); }
  if (remoteAudios.has(peerId)) {
    remoteAudios.get(peerId).srcObject = null;
    remoteAudios.get(peerId).remove();
    remoteAudios.delete(peerId);
  }
  stopSpeakingDetection(peerId);
  pendingCandidates.delete(peerId);
  userMuted.delete(peerId);
  userVolume.delete(peerId);
  const fc = fileChannels.get(peerId);
  if (fc) { try { fc.close(); } catch(e) {} fileChannels.delete(peerId); }
  // Clean up pending file transfers from this peer
  for (const [fid, info] of pendingFiles) {
    if (info.fromPeer === peerId) pendingFiles.delete(fid);
  }
  refreshUserList();
}

function closeAllPeerConnections() {
  for (const peerId of peerConnections.keys()) closePeerConnection(peerId);
}

function cleanupWebRTC() {
  closeAllPeerConnections();
  peerConnections.clear();
  remoteAudios.forEach(a => { a.srcObject = null; a.remove(); });
  remoteAudios.clear();
  pendingCandidates.clear();
}

function hasPeerConnection(peerId) {
  return peerConnections.has(peerId);
}
