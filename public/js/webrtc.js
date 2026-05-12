// ── WebRTC mesh (2 users only) ──────────────────────────────────────────────
// Direct P2P audio between exactly 2 peers. For 3+ users, relay.js handles audio.
// Depends on: config.js, audio.js, net.js (sendWs)

const peerConnections = new Map();    // peerId → RTCPeerConnection
const remoteAudios = new Map();       // peerId → HTMLAudioElement
const pendingCandidates = new Map();  // peerId → RTCIceCandidate[]

// ── Audio element mute control (called by audio.js) ─────────────────────────

function updateRemoteAudioMutes(deafened) {
  remoteAudios.forEach(a => {
    a.muted = deafened;
    if (!deafened) a.play().catch(() => {});
  });
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

// Attach local audio tracks to a peer connection.
function attachLocalTracks(pc) {
  const stream = getLocalStream();
  if (!stream) return;
  pc.getSenders().forEach(s => pc.removeTrack(s));
  stream.getTracks().forEach(track => pc.addTrack(track, stream));
}

function addRemoteStream(peerId, stream) {
  if (remoteAudios.has(peerId)) {
    remoteAudios.get(peerId).srcObject = null;
    remoteAudios.get(peerId).remove();
  }
  const audio = new Audio();
  audio.srcObject = stream;
  audio.autoplay = true;
  audio.muted = isDeafened;
  audio.play().catch(e => console.warn('Audio play failed:', e));
  remoteAudios.set(peerId, audio);
  startSpeakingDetection(peerId, stream, false);
  refreshUserList();
}

// ── Initiating connections ─────────────────────────────────────────────────

async function initiateWebRTC(peerId) {
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
