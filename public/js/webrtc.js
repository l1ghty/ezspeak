// ── WebRTC full mesh ───────────────────────────────────────────────────────
// Direct P2P audio + video between all peers in a channel (2+ users).
// Each client connects to every other client.  Browsers natively mix
// multiple <audio> elements — no custom mixer needed.
//
// Depends on: config.js, audio.js, net.js (sendWs)

const peerConnections = new Map();    // peerId → RTCPeerConnection
const remoteAudios = new Map();       // peerId → HTMLAudioElement
const remoteVideos = new Map();       // peerId → { stream }
const pendingCandidates = new Map();  // peerId → RTCIceCandidate[]

let localVideoStream = null;          // Local video stream (camera or screen)
let localVideoSource = null;         // 'camera' or 'screen'
let _onPeerVideoChange = null;        // callback(peerId, active)
const peerVideoSources = new Map();  // peerId → 'camera' | 'screen'

// ── Per-user volume / mute ─────────────────────────────────────────────────

const userVolume = new Map();  // peerId → slider value (0-200)
const userMuted  = new Map();  // peerId → boolean

function sliderToAudioVolume(sliderVal) {
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
  for (const peerId of remoteAudios.keys()) {
    applyPeerAudioState(peerId);
  }
}

function retryAllRemoteAudio() {
  remoteAudios.forEach(a => {
    if (!a.muted) a.play().catch(() => {});
  });
}

// ── Video sharing (local webcam) ────────────────────────────────────────────

function onPeerVideoChange(fn) { _onPeerVideoChange = fn; }

async function startSharingVideo() {
  if (localVideoStream) return true;
  const savedCam = localStorage.getItem('ezspeak_cam');
  const constraints = { video: true };
  if (savedCam) constraints.video = { deviceId: { exact: savedCam } };
  try {
    localVideoStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    console.warn('[video] camera not available:', e.message);
    return false;
  }
  localVideoSource = 'camera';
  addVideoToAllPeers();
  await renegotiateAllPeers();
  sendWs({ type: 'video-state-changed', active: true, source: 'camera' });
  if (_onPeerVideoChange) _onPeerVideoChange(userId, true);
  return true;
}

async function startSharingScreen() {
  if (localVideoStream) stopSharingVideo();

  if (!navigator.mediaDevices?.getDisplayMedia) {
    alert('Screen sharing is not supported on this device. It works on desktop Chrome, Firefox, and Edge.');
    return false;
  }

  try {
    localVideoStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  } catch (e) {
    if (e.name === 'AbortError' || e.name === 'NotAllowedError') {
      // User cancelled the picker — no message needed
    } else {
      console.warn('[screen] display share error:', e.message);
      alert('Screen sharing failed: ' + (e.message || 'unknown error'));
    }
    return false;
  }
  localVideoSource = 'screen';
  // Listen for browser "Stop Sharing" button
  localVideoStream.getVideoTracks().forEach(track => {
    track.addEventListener('ended', () => {
      if (localVideoSource === 'screen') stopSharingVideo();
    });
  });
  addVideoToAllPeers();
  await renegotiateAllPeers();
  sendWs({ type: 'video-state-changed', active: true, source: 'screen' });
  if (_onPeerVideoChange) _onPeerVideoChange(userId, true);
  return true;
}

function addVideoToAllPeers() {
  if (!localVideoStream) return;
  for (const [peerId, pc] of peerConnections) {
    localVideoStream.getVideoTracks().forEach(track => {
      // Remove existing video senders first (in case of switch)
      const existingSenders = pc.getSenders().filter(s => s.track?.kind === 'video');
      existingSenders.forEach(s => pc.removeTrack(s));
      pc.addTrack(track, localVideoStream);
    });
  }
}

function stopSharingVideo() {
  if (!localVideoStream) return;
  for (const [peerId, pc] of peerConnections) {
    const senders = pc.getSenders().filter(s => s.track?.kind === 'video');
    senders.forEach(s => pc.removeTrack(s));
  }
  localVideoStream.getVideoTracks().forEach(t => t.stop());
  localVideoStream = null;
  localVideoSource = null;
  renegotiateAllPeers();
  sendWs({ type: 'video-state-changed', active: false });
  if (_onPeerVideoChange) _onPeerVideoChange(userId, false);
}

function isSharingVideo() {
  return !!localVideoStream;
}

function isSharingScreen() {
  return !!(localVideoStream && localVideoSource === 'screen');
}

function getPeerVideoSource(peerId) {
  return peerVideoSources.get(peerId) || null;
}

async function renegotiateAllPeers() {
  for (const [peerId, pc] of peerConnections) {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendWs({ type: 'webrtc-offer', targetId: peerId, offer });
    } catch (e) {
      console.error('[video] renegotiate error for', peerId, e);
    }
  }
}

// ── Remote video ────────────────────────────────────────────────────────────

function addRemoteVideo(peerId, stream) {
  stream.getVideoTracks().forEach(track => {
    track.addEventListener('ended', () => removeRemoteVideo(peerId));
  });
  stream.addEventListener('removetrack', (e) => {
    if (e.track.kind === 'video') removeRemoteVideo(peerId);
  });
  remoteVideos.set(peerId, { stream });
  if (_onPeerVideoChange) _onPeerVideoChange(peerId, true);
}

function removeRemoteVideo(peerId) {
  remoteVideos.delete(peerId);
  peerVideoSources.delete(peerId);
  if (_onPeerVideoChange) _onPeerVideoChange(peerId, false);
}

function hasPeerVideo(peerId) {
  return remoteVideos.has(peerId);
}

function getPeerVideoStream(peerId) {
  return remoteVideos.get(peerId)?.stream || null;
}

// ── Peer connection ─────────────────────────────────────────────────────────

function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection(RTC_CONFIG);

  pc.onicecandidate = (e) => {
    if (e.candidate) sendWs({ type: 'webrtc-ice-candidate', targetId: peerId, candidate: e.candidate });
  };

  pc.ontrack = (e) => {
    if (e.track.kind === 'video' && e.streams?.[0]) {
      addRemoteVideo(peerId, e.streams[0]);
    }
    if (e.track.kind === 'audio' && e.streams?.[0]) {
      addRemoteStream(peerId, e.streams[0]);
    }
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
  if (stream) {
    stream.getTracks().forEach(track => pc.addTrack(track, stream));
  }
  // Also attach video track if sharing webcam
  if (localVideoStream) {
    localVideoStream.getVideoTracks().forEach(track => pc.addTrack(track, localVideoStream));
  }
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
  startSpeakingDetection(peerId, stream, false);
  refreshUserList();
}

// ── Initiating connections ─────────────────────────────────────────────────

async function initiateWebRTC(peerId) {
  console.log('[webrtc] initiateWebRTC to ' + peerId);
  await ensureLocalStream();
  const pc = createPeerConnection(peerId);
  attachLocalTracks(pc);
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
  // Reuse existing peer connection during renegotiation, don't overwrite
  const existing = peerConnections.get(fromId);
  const pc = existing || createPeerConnection(fromId);
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    if (!existing) {
      // First-time connection: attach local tracks and data channel
      attachLocalTracks(pc);
      if (!fileChannels.has(fromId)) createDataChannel(fromId);
    }
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

const fileChannels = new Map();
const pendingFiles = new Map();
const fileBlobs = new Map();
const CHUNK_SIZE = 16384;
let _onFileReceived = null;

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

function announceFile(file) {
  const fileId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  fileBlobs.set(fileId, file);
  sendWs({ type: 'file-announce', fileId, fileName: file.name, fileSize: file.size, fileType: file.type });
  if (_onFileReceived) _onFileReceived(userId, 'You', file.name, null, file.size, fileId, true);
}

async function requestFile(peerId, fileId) {
  const info = pendingFiles.get(fileId);
  if (!info) return;
  const channel = fileChannels.get(peerId);
  if (!channel || channel.readyState !== 'open') {
    if (!channel) createDataChannel(peerId);
    const ch = fileChannels.get(peerId);
    if (ch) ch.addEventListener('open', () => requestFile(peerId, fileId), { once: true });
    return;
  }
  const dlBtn = document.querySelector('.file-dl-btn[data-fileid="' + fileId + '"]');
  if (dlBtn) { dlBtn.textContent = '\u23f3 Requesting...'; dlBtn.disabled = true; }
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: info.name });
      const writable = await handle.createWritable();
      info.writable = writable;
      info.written = 0;
      info.dlBtn = dlBtn;
      channel.send(JSON.stringify({ t: 'request', id: fileId }));
      return;
    } catch (e) {
      if (e.name === 'AbortError') {
        if (dlBtn) { dlBtn.textContent = '\u2b07 Download'; dlBtn.disabled = false; }
        return;
      }
    }
  }
  if (info.size > 500 * 1024 * 1024) {
    alert('File is too large for this browser. Please use Chrome for files > 500 MB.');
    if (dlBtn) { dlBtn.textContent = '\u2b07 Download'; dlBtn.disabled = false; }
    return;
  }
  info.dlBtn = dlBtn;
  channel.send(JSON.stringify({ t: 'request', id: fileId }));
}

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

function handleFileChunk(peerId, data) {
  if (!(data instanceof ArrayBuffer)) return;
  const view = new DataView(data);
  const type = view.getUint8(0);
  if (type === 0x43) {
    const chunkIdx = view.getUint32(1, true);
    const fileIdHash = view.getUint32(5, true);
    const chunkData = data.slice(9);
    for (const [fileId, info] of pendingFiles) {
      if (hashFileId(fileId) === fileIdHash && info.fromPeer === peerId) {
        if (info.writable) {
          info.writable.write(new Uint8Array(chunkData));
          info.written += chunkData.byteLength;
          if (info.dlBtn) {
            const pct = Math.round((info.written / info.size) * 100);
            info.dlBtn.textContent = '\u23f3 ' + pct + '%';
          }
        } else {
          if (!info.chunks) info.chunks = new Map();
          info.chunks.set(chunkIdx, new Uint8Array(chunkData));
        }
        return;
      }
    }
  } else if (type === 0x45) {
    const fileIdHash = view.getUint32(1, true);
    for (const [fileId, info] of pendingFiles) {
      if (hashFileId(fileId) === fileIdHash && info.fromPeer === peerId) {
        console.log('[file] received ' + info.name + ' (' + info.size + ') from ' + info.fromName);
        if (info.writable) {
          info.writable.close().then(() => {
            if (info.dlBtn) { info.dlBtn.textContent = '\u2705 Done'; info.dlBtn.disabled = true; }
          }).catch(e => {
            console.error('[file] write error:', e);
            if (info.dlBtn) { info.dlBtn.textContent = '\u274c Failed'; }
          });
        } else {
          const result = new Uint8Array(info.size);
          let written = 0;
          for (let i = 0; i < info.chunks.size; i++) {
            const chunk = info.chunks.get(i);
            if (chunk) { result.set(chunk, written); written += chunk.byteLength; }
          }
          const blob = new Blob([result], { type: info.mimeType || 'application/octet-stream' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = info.name;
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 60000);
          if (info.dlBtn) { info.dlBtn.textContent = '\u2705 Done'; info.dlBtn.disabled = true; }
        }
        pendingFiles.delete(fileId);
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
  // Clean up remote video
  if (remoteVideos.has(peerId)) {
    removeRemoteVideo(peerId);
  }
  stopSpeakingDetection(peerId);
  pendingCandidates.delete(peerId);
  userMuted.delete(peerId);
  userVolume.delete(peerId);
  const fc = fileChannels.get(peerId);
  if (fc) { try { fc.close(); } catch(e) {} fileChannels.delete(peerId); }
  for (const [fid, info] of pendingFiles) {
    if (info.fromPeer === peerId) pendingFiles.delete(fid);
  }
  refreshUserList();
}

function closeAllPeerConnections() {
  for (const peerId of peerConnections.keys()) closePeerConnection(peerId);
}

function cleanupWebRTC() {
  stopSharingVideo();
  closeAllPeerConnections();
  peerConnections.clear();
  remoteAudios.forEach(a => { a.srcObject = null; a.remove(); });
  remoteAudios.clear();
  remoteVideos.clear();
  pendingCandidates.clear();
}

function hasPeerConnection(peerId) {
  return peerConnections.has(peerId);
}
