// ── WebRTC mesh ─────────────────────────────────────────────────────────────
// Manages peer-to-peer audio connections in a full-mesh topology.
// Depends on: config.js, audio.js, net.js (sendWs)

const peerConnections = new Map();    // peerId → RTCPeerConnection
const remoteAudios = new Map();       // peerId → HTMLAudioElement
const pendingCandidates = new Map();  // peerId → RTCIceCandidate[]

// Audio mixing (used when this peer is the mixer)
let mixerContext = null;
const mixerSources = new Map();       // peerId → { source, gain }
const peerDestinations = new Map();    // peerId → { destination, connections: Map }
let isMixerActive = false;
let mixerAudioEl = null;
let mixerLocalGain = null;            // local monitor gain node

// Reference to current channel mixer (set by app.js signaling)
let channelMixer = null;

function updateRemoteAudioMutes(deafened) {
  remoteAudios.forEach(a => {
    a.muted = deafened;
    if (!deafened && !isMixerSolo(a)) a.play().catch(() => {});
  });
}

// Called by audio.js on first user interaction (recovers from autoplay block)
function retryAllRemoteAudio() {
  remoteAudios.forEach(a => {
    if (!a.muted) a.play().catch(() => {});
  });
  if (mixerAudioEl && !mixerAudioEl.muted) mixerAudioEl.play().catch(() => {});
}

function isMixerSolo(audio) {
  // If mixing is active and we're not the mixer, only the mixer audio is audible
  return channelMixer && !isMixerActive;
}

// --- Audio mixing (mixer peer only) -----------------------------------------
// Per-peer mixes: each peer gets a mix of all sources EXCEPT their own.
// This prevents users from hearing their own voice echoed back.

function setupMixer() {
  if (mixerContext) return;
  mixerContext = new AudioContext();
}

function addSourceToMixer(id, stream) {
  if (!mixerContext) return;
  if (!stream || !stream.getAudioTracks().length) return;
  try {
    removeSourceFromMixer(id);
    const source = mixerContext.createMediaStreamSource(stream);
    const gain = mixerContext.createGain();
    gain.gain.value = 1.0;
    source.connect(gain);
    mixerSources.set(id, { source, gain });
    // Connect this source to all existing peer destinations (except its own)
    for (const [peerId, entry] of peerDestinations) {
      if (id !== peerId) {
        entry.connections.set(id, gain);
        gain.connect(entry.destination);
      }
    }
    rebuildLocalMonitor();
  } catch (e) { console.warn('addSourceToMixer failed:', e); }
}

function removeSourceFromMixer(id) {
  const entry = mixerSources.get(id);
  if (entry) {
    entry.source.disconnect();
    entry.gain.disconnect();
    mixerSources.delete(id);
  }
}

function createPeerMix(peerId, pc) {
  if (!mixerContext) return;
  // Remove old mix for this peer
  destroyPeerMix(peerId);

  const dest = mixerContext.createMediaStreamDestination();
  const connections = new Map();

  // Connect all sources EXCEPT this peer's own
  for (const [srcId, src] of mixerSources) {
    if (srcId !== peerId) {
      connections.set(srcId, src.gain);
      src.gain.connect(dest);
    }
  }

  peerDestinations.set(peerId, { destination: dest, connections });

  const mixedTrack = dest.stream.getAudioTracks()[0];
  if (mixedTrack) replaceOutgoingTrack(pc, mixedTrack);
}

function destroyPeerMix(peerId) {
  const entry = peerDestinations.get(peerId);
  if (entry) {
    for (const [srcId, gain] of entry.connections) {
      gain.disconnect(entry.destination);
    }
    entry.destination.stream.getTracks().forEach(t => t.stop());
    peerDestinations.delete(peerId);
  }
}

function startMixing() {
  if (isMixerActive) return;
  try {
    setupMixer();
    isMixerActive = true;

    const local = getLocalStream();
    if (local) addSourceToMixer('__self__', local);

    for (const [peerId, audio] of remoteAudios) {
      if (audio.srcObject) addSourceToMixer(peerId, audio.srcObject);
    }

    // Build per-peer mixes for all existing connections
    for (const [peerId, pc] of peerConnections) {
      createPeerMix(peerId, pc);
    }

    rebuildLocalMonitor();
  } catch (e) { console.error('startMixing failed:', e); stopMixing(); }
}

function stopMixing() {
  isMixerActive = false;

  // Restore local tracks
  const local = getLocalStream();
  if (local) {
    const localTrack = local.getAudioTracks()[0];
    for (const [peerId, pc] of peerConnections) {
      replaceOutgoingTrack(pc, localTrack);
    }
  }

  // Destroy all peer mixes
  for (const peerId of peerDestinations.keys()) {
    destroyPeerMix(peerId);
  }

  // Disconnect all sources
  for (const [id, entry] of mixerSources) {
    entry.source.disconnect();
    entry.gain.disconnect();
  }
  mixerSources.clear();

  // Stop local monitor
  destroyLocalMonitor();
}

// --- Local monitor (mixer hears everyone including self) ---------------------

function rebuildLocalMonitor() {
  destroyLocalMonitor();
  if (!mixerContext || !isMixerActive) return;

  const dest = mixerContext.createMediaStreamDestination();
  mixerLocalGain = mixerContext.createGain();
  mixerLocalGain.gain.value = 1.0;

  // Connect all sources
  for (const [id, src] of mixerSources) {
    src.gain.connect(mixerLocalGain);
  }
  mixerLocalGain.connect(dest);

  // Play the combined stream locally
  mixerAudioEl = new Audio();
  mixerAudioEl.srcObject = dest.stream;
  mixerAudioEl.autoplay = true;
  mixerAudioEl.muted = isDeafened;
  mixerAudioEl.play().catch(() => {});
}

function destroyLocalMonitor() {
  if (mixerLocalGain) {
    mixerLocalGain.disconnect();
    mixerLocalGain = null;
  }
  if (mixerAudioEl) {
    mixerAudioEl.srcObject = null;
    mixerAudioEl.remove();
    mixerAudioEl = null;
  }
}

function addStreamToMixer(id, stream) {
  // Wrapper for backward compatibility with addRemoteStream
  if (!isMixerActive) return;
  addSourceToMixer(id, stream);
  // Also create peer mix if a new connection was established
  if (peerConnections.has(id)) {
    createPeerMix(id, peerConnections.get(id));
  }
}

function replaceOutgoingTrack(pc, newTrack) {
  if (!newTrack || !pc) return;
  try {
    const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
    if (sender) sender.replaceTrack(newTrack).catch(e => console.warn('replaceTrack failed:', e));
  } catch (e) { console.warn('replaceOutgoingTrack failed:', e); }
}

// Called by initiateWebRTC after creating a new connection while mixing
function onNewPeerConnection(peerId, pc) {
  if (isMixerActive) {
    createPeerMix(peerId, pc);
  }
}

function setChannelMixer(mixerId, myUserId) {
  try {
    channelMixer = mixerId;
    const iAmMixer = (mixerId && mixerId === myUserId);

    if (iAmMixer && !isMixerActive) {
      startMixing();
    } else if (!iAmMixer && isMixerActive) {
      stopMixing();
    }

    if (!iAmMixer && mixerId) {
      applyMixerMute();
      if (remoteAudios.has(mixerId)) {
        const audio = remoteAudios.get(mixerId);
        if (audio.srcObject) {
          stopSpeakingDetection(mixerId);
          startSpeakingDetection(mixerId, audio.srcObject, false);
        }
      }
    } else if (!mixerId) {
      remoteAudios.forEach(a => { a.muted = isDeafened; });
    }
  } catch (e) { console.error('setChannelMixer failed:', e); }
}

function applyMixerMute() {
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
  // Use mixed track if we're the active mixer, otherwise local tracks
  if (isMixerActive && mixerContext) {
    // Create peer mix for this new connection
    onNewPeerConnection(peerId, pc);
  } else {
    attachLocalTracks(pc);
  }
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
    if (isMixerActive && mixerContext) {
      onNewPeerConnection(fromId, pc);
    } else {
      attachLocalTracks(pc);
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
  destroyLocalMonitor();
}

function hasPeerConnection(peerId) {
  return peerConnections.has(peerId);
}
