// ── WebRTC mesh ─────────────────────────────────────────────────────────────
// Manages peer-to-peer audio connections in a full-mesh topology.
// Depends on: config.js, audio.js, net.js (sendWs)

const peerConnections = new Map();    // peerId → RTCPeerConnection
const remoteAudios = new Map();       // peerId → HTMLAudioElement
const pendingCandidates = new Map();  // peerId → RTCIceCandidate[]

// Audio mixing (used when this peer is the mixer)
let mixerContext = null;
let mixerDestination = null;
const mixerSources = new Map();       // peerId → MediaStreamAudioSourceNode
let isMixerActive = false;

// Reference to current channel mixer (set by app.js signaling)
let channelMixer = null;

// --- Audio element mute control (called by audio.js) -------------------------

function updateRemoteAudioMutes(deafened) {
  remoteAudios.forEach(a => {
    a.muted = deafened;
    if (!deafened && !isMixerSolo(a)) a.play().catch(() => {});
  });
}

function isMixerSolo(audio) {
  // If mixing is active and we're not the mixer, only the mixer audio is audible
  return channelMixer && !isMixerActive;
}

// --- Audio mixing (mixer peer only) -----------------------------------------

function setupMixer() {
  if (mixerContext) return;
  mixerContext = new AudioContext();
  mixerDestination = mixerContext.createMediaStreamDestination();
}

function startMixing() {
  if (isMixerActive) return;
  setupMixer();
  isMixerActive = true;

  // Add own microphone to the mix
  const local = getLocalStream();
  if (local) {
    addStreamToMixer('__self__', local);
  }

  // Add any existing remote streams
  for (const [peerId, audio] of remoteAudios) {
    if (audio.srcObject) addStreamToMixer(peerId, audio.srcObject);
  }

  // Replace outgoing audio track on all connections with mixed stream
  const mixedTrack = mixerDestination.stream.getAudioTracks()[0];
  for (const [peerId, pc] of peerConnections) {
    replaceOutgoingTrack(pc, mixedTrack);
  }

  // Play the mixed stream locally so the mixer hears everyone
  playMixedStreamLocally();
}

function stopMixing() {
  isMixerActive = false;

  // Restore original local tracks on all connections
  const local = getLocalStream();
  if (local) {
    const localTrack = local.getAudioTracks()[0];
    for (const [peerId, pc] of peerConnections) {
      replaceOutgoingTrack(pc, localTrack);
    }
  }

  // Disconnect all mixer sources
  for (const [id, source] of mixerSources) {
    source.disconnect();
  }
  mixerSources.clear();

  // Stop local mix playback
  if (mixerAudioEl) {
    mixerAudioEl.srcObject = null;
    mixerAudioEl.remove();
    mixerAudioEl = null;
  }
}

let mixerAudioEl = null;

function playMixedStreamLocally() {
  if (mixerAudioEl) {
    mixerAudioEl.srcObject = null;
    mixerAudioEl.remove();
  }
  mixerAudioEl = new Audio();
  mixerAudioEl.srcObject = mixerDestination.stream;
  mixerAudioEl.autoplay = true;
  mixerAudioEl.play().catch(() => {});
}

function addStreamToMixer(id, stream) {
  if (!mixerContext || !mixerDestination) return;
  // Remove existing source for this id
  if (mixerSources.has(id)) {
    mixerSources.get(id).disconnect();
    mixerSources.delete(id);
  }
  const source = mixerContext.createMediaStreamSource(stream);
  source.connect(mixerDestination);
  mixerSources.set(id, source);
}

function replaceOutgoingTrack(pc, newTrack) {
  if (!newTrack) return;
  const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
  if (sender) {
    sender.replaceTrack(newTrack).catch(e => console.warn('replaceTrack failed:', e));
  }
}

function setChannelMixer(mixerId, myUserId) {
  const prevMixer = channelMixer;
  channelMixer = mixerId;
  const iAmMixer = (mixerId === myUserId);

  if (iAmMixer && !isMixerActive) {
    startMixing();
  } else if (!iAmMixer && isMixerActive) {
    stopMixing();
  }

  if (!iAmMixer && mixerId) {
    // Non-mixer: mute all remote audio except from the mixer
    applyMixerMute();
  } else if (!mixerId) {
    // No mixer (2 or fewer users): unmute everything
    remoteAudios.forEach(a => { a.muted = isDeafened; });
  }
}

function applyMixerMute() {
  // Mute remote audio that's NOT from the mixer
  // We need to know which audio element belongs to which peerId
  // remoteAudios is keyed by peerId
  for (const [peerId, audio] of remoteAudios) {
    if (channelMixer && peerId !== channelMixer) {
      audio.muted = true;
    } else {
      audio.muted = isDeafened;
    }
  }
}

// --- Peer connection ---------------------------------------------------------

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
  // Remove any existing senders first (idempotent)
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

  // Mixer logic: if we're the mixer, add stream to mix; if not, mute non-mixer audio
  if (isMixerActive) {
    addStreamToMixer(peerId, stream);
    audio.muted = isDeafened;
  } else if (channelMixer && peerId !== channelMixer) {
    audio.muted = true;  // mute non-mixer peers
  } else {
    audio.muted = isDeafened;
  }

  audio.play().catch(e => console.warn('Audio play failed:', e));
  remoteAudios.set(peerId, audio);
  startSpeakingDetection(peerId, stream, false);
  refreshUserList();
}

// --- Initiating connections --------------------------------------------------

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

// --- Handling incoming signaling ---------------------------------------------

async function handleOffer(fromId, offer) {
  await ensureLocalStream();
  const pc = createPeerConnection(fromId);
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    // Attach tracks AFTER setting remote description so they appear in the answer
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

// --- Cleanup -----------------------------------------------------------------

function closePeerConnection(peerId) {
  const pc = peerConnections.get(peerId);
  if (pc) { pc.close(); peerConnections.delete(peerId); }
  if (remoteAudios.has(peerId)) {
    remoteAudios.get(peerId).srcObject = null;
    remoteAudios.get(peerId).remove();
    remoteAudios.delete(peerId);
  }
  // Remove from mixer
  if (mixerSources.has(peerId)) {
    mixerSources.get(peerId).disconnect();
    mixerSources.delete(peerId);
  }
  stopSpeakingDetection(peerId);
  pendingCandidates.delete(peerId);
  refreshUserList();
}

function closeAllPeerConnections() {
  for (const peerId of peerConnections.keys()) closePeerConnection(peerId);
}

function cleanupWebRTC() {
  stopMixing();
  closeAllPeerConnections();
  peerConnections.clear();
  remoteAudios.forEach(a => { a.srcObject = null; a.remove(); });
  remoteAudios.clear();
  pendingCandidates.clear();
  if (mixerAudioEl) { mixerAudioEl.srcObject = null; mixerAudioEl.remove(); mixerAudioEl = null; }
}

function hasPeerConnection(peerId) {
  return peerConnections.has(peerId);
}
