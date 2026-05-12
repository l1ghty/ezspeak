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
  // Slider at 100 = volume 1.0 (unity). Slider at 50 ≈ perceived half volume.
  const norm = Math.max(0, sliderVal / 100);
  return Math.pow(Math.min(norm, 2) / 2, 1.2) * 2;
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
