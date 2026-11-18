// ── WebRTC full mesh ───────────────────────────────────────────────────────
// Direct P2P audio + video between all peers in a channel. Each client
// connects to every other client; browsers mix the <audio> elements.
//
// Stability design:
//  • Every RTCPeerConnection is one "session" identified by a connId that
//    travels with every offer/answer/candidate. A peer that reloads or
//    re-creates its side sends a new connId and the other side replaces its
//    stale connection instead of mixing two sessions (decideOffer()).
//  • Perfect negotiation (polite/impolite) for renegotiation glare; the
//    side that did NOT create the session is polite.
//  • All remote signaling for one peer is processed strictly in order
//    through a per-peer promise queue.
//  • ICE 'disconnected' is transient: we wait, then ICE-restart, and only
//    after repeated failure build a brand new session.
//  • A watchdog re-establishes connections to any channel member we are
//    not (or no longer) connected to.
//  • Relay-only mode (TURN) hides every user's IP from other users.
//
// Depends on: shared.js, config.js, audio.js, net.js (sendWs)

const peerConnections = new Map();    // peerId → RTCPeerConnection (current session)
const pcMeta = new WeakMap();         // pc → session metadata
const signalQueues = new Map();       // peerId → Promise (serialized signaling)
const peerSeenAt = new Map();         // peerId → ts we learned the peer is in our channel
const remoteAudios = new Map();       // peerId → HTMLAudioElement
const remoteVideos = new Map();       // peerId → { stream }

let localVideoStream = null;          // Local video stream (camera or screen)
let localVideoSource = null;          // 'camera' or 'screen'
let _onPeerVideoChange = null;        // callback(peerId, active)
const peerVideoSources = new Map();   // peerId → 'camera' | 'screen'

// Timing (ms)
const ICE_DISCONNECT_GRACE = 3000;    // wait before ICE restart on 'disconnected'
const ICE_RESTART_TIMEOUT = 10000;    // per ICE-restart attempt
const MAX_ICE_RESTARTS = 2;
const CONNECT_TIMEOUT = 20000;        // a session stuck in 'new'/'connecting'
const PEER_WAIT_BEFORE_WATCHDOG = 5000;
const WATCHDOG_INTERVAL = 4000;

// ── RTC policy (ICE servers / relay-only) ──────────────────────────────────

let rtcIceServers = (typeof RTC_CONFIG !== 'undefined' && RTC_CONFIG.iceServers) || [];
let rtcForceRelay = false;            // set by server (room relay-only or FORCE_RELAY)
let _onRelayUnavailable = null;

function onRelayUnavailable(fn) { _onRelayUnavailable = fn; }

function localRelayPreference() {
  try { return localStorage.getItem(LS_RELAY_ONLY) === '1'; } catch { return false; }
}

function isRelayOnly() {
  return rtcForceRelay || localRelayPreference();
}

function canUseRelay() {
  return hasTurnServer(rtcIceServers);
}

// Update ICE servers / room policy. When the effective relay mode changes,
// all connections are rebuilt so no old (direct) path keeps being used.
function setRtcPolicy({ iceServers, forceRelay } = {}) {
  const before = isRelayOnly();
  if (Array.isArray(iceServers)) rtcIceServers = iceServers;
  if (typeof forceRelay === 'boolean') rtcForceRelay = forceRelay;
  if (before !== isRelayOnly()) rebuildAllPeers();
}

function rebuildAllPeers() {
  const ids = [...peerConnections.keys()];
  ids.forEach(id => closePeerConnection(id));
  const now = Date.now();
  for (const id of ids) {
    peerSeenAt.set(id, now);
    // One deterministic side reconnects right away; the watchdog covers the other.
    if (isPreferredInitiator(userId, id)) connectToPeer(id);
  }
}

// ── Per-user volume / mute ─────────────────────────────────────────────────

const userVolume = new Map();  // peerId → slider value (0-100)
const userMuted  = new Map();  // peerId → boolean

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

function updateRemoteAudioMutes() {
  for (const peerId of remoteAudios.keys()) applyPeerAudioState(peerId);
}

function retryAllRemoteAudio() {
  remoteAudios.forEach(a => { if (!a.muted && a.paused) a.play().catch(() => {}); });
}

// ── Alert wrapper (custom modal when available, native fallback) ──────────

function ezAlert(msg) {
  if (typeof showAlert === 'function') { showAlert(msg); return; }
  alert(msg);
}

// ── Signaling helpers ──────────────────────────────────────────────────────

function sendSignal(type, peerId, connId, payload) {
  sendWs({ type, targetId: peerId, connId, ...payload });
}

function enqueueSignal(peerId, fn) {
  const prev = signalQueues.get(peerId) || Promise.resolve();
  const next = prev.then(fn).catch(err => console.warn('[webrtc] signaling error for', peerId, err));
  signalQueues.set(peerId, next);
  return next;
}

function pcState(pc) {
  return pc.connectionState || pc.iceConnectionState;
}

function isPcConnected(pc) {
  const s = pcState(pc);
  return s === 'connected' || s === 'completed';
}

function isCurrent(peerId, pc) {
  return peerConnections.get(peerId) === pc;
}

// 'connected' | 'connecting' | 'disconnected' — for the UI indicator
function getPeerConnectionState(peerId) {
  const pc = peerConnections.get(peerId);
  if (!pc) return 'disconnected';
  if (isPcConnected(pc)) return 'connected';
  const s = pcState(pc);
  return (s === 'failed' || s === 'closed') ? 'disconnected' : 'connecting';
}

function hasPeerConnection(peerId) {
  return peerConnections.has(peerId);
}

// ── Peer connection lifecycle ──────────────────────────────────────────────

function createPeerConnection(peerId, connId, isInitiator) {
  const relayOnly = isRelayOnly();
  const pc = new RTCPeerConnection(buildRtcConfig(rtcIceServers, relayOnly));
  const meta = {
    connId, isInitiator, relayOnly,
    makingOffer: false, ignoreOffer: false,
    pendingCandidates: [],
    createdAt: Date.now(),
    restartAttempts: 0,
    recoveryTimer: null,
  };
  pcMeta.set(pc, meta);
  peerConnections.set(peerId, pc);

  pc.onicecandidate = (e) => {
    if (!e.candidate || !isCurrent(peerId, pc)) return;
    const c = e.candidate.toJSON ? e.candidate.toJSON() : e.candidate;
    if (meta.relayOnly && c.candidate) {
      c.candidate = sanitizeCandidate(c.candidate);
      if (!c.candidate) return;  // never reveal host/srflx addresses
    }
    sendSignal('webrtc-ice-candidate', peerId, connId, { candidate: c });
  };

  pc.ontrack = (e) => {
    if (!isCurrent(peerId, pc)) return;
    const stream = e.streams?.[0] || new MediaStream([e.track]);
    if (e.track.kind === 'audio') addRemoteStream(peerId, stream);
    else if (e.track.kind === 'video' && e.streams?.[0]) addRemoteVideo(peerId, stream);
  };

  pc.ondatachannel = (e) => onDataChannel(peerId, e.channel);

  pc.onnegotiationneeded = () => negotiate(peerId, pc);

  const onState = () => handleConnectionState(peerId, pc);
  pc.onconnectionstatechange = onState;
  pc.oniceconnectionstatechange = onState;

  return pc;
}

// Initiator side of perfect negotiation (also used for renegotiation and
// ICE restarts by either side).
async function negotiate(peerId, pc) {
  const meta = pcMeta.get(pc);
  if (!meta || !isCurrent(peerId, pc)) return;
  try {
    meta.makingOffer = true;
    await pc.setLocalDescription();
    if (!isCurrent(peerId, pc) || pc.signalingState !== 'have-local-offer') return;
    sendSignal('webrtc-offer', peerId, meta.connId, { offer: localDescriptionForWire(pc, meta) });
  } catch (err) {
    console.warn('[webrtc] negotiation failed for', peerId, err);
  } finally {
    meta.makingOffer = false;
  }
}

function localDescriptionForWire(pc, meta) {
  const d = pc.localDescription;
  return { type: d.type, sdp: meta.relayOnly ? stripNonRelayFromSdp(d.sdp) : d.sdp };
}

// Start a fresh session to `peerId` with us as the initiator.
async function connectToPeer(peerId) {
  peerId = String(peerId);
  if (peerId === String(userId)) return;
  if (isRelayOnly() && !canUseRelay()) {
    if (_onRelayUnavailable) _onRelayUnavailable();
    return;
  }
  await ensureLocalStream();
  const old = peerConnections.get(peerId);
  if (old) closePeerConnection(peerId);
  peerSeenAt.set(peerId, Date.now());
  const pc = createPeerConnection(peerId, newConnId(), true);
  attachLocalTracks(pc);
  createDataChannel(peerId);   // also guarantees an initial negotiation
}

// Back-compat name used by older call sites.
function initiateWebRTC(peerId) { return connectToPeer(peerId); }

function attachLocalTracks(pc) {
  const stream = getLocalStream();
  const audioTrack = stream?.getAudioTracks()[0];
  if (audioTrack) {
    // Reuse a transceiver created by the remote offer when there is one.
    pc.addTrack(audioTrack, stream);
  } else if (!pc.getTransceivers().some(t => t.receiver.track?.kind === 'audio')) {
    // No microphone: still ask to receive audio.
    pc.addTransceiver('audio', { direction: 'recvonly' });
  }
  if (localVideoStream) {
    localVideoStream.getVideoTracks().forEach(track => addOrReuseVideoSender(pc, track, localVideoStream));
  }
}

// Called by audio.js / settings when the microphone becomes available later.
function attachLocalAudioToAllPeers() {
  const stream = getLocalStream();
  const track = stream?.getAudioTracks()[0];
  if (!track) return;
  for (const pc of peerConnections.values()) {
    const existing = pc.getSenders().find(s => s.track?.kind === 'audio');
    if (existing) { existing.replaceTrack(track).catch(() => {}); continue; }
    const t = pc.getTransceivers().find(tr => tr.receiver.track?.kind === 'audio' && !tr.sender.track && !tr.stopped);
    if (t) {
      t.sender.replaceTrack(track).catch(() => {});
      t.sender.setStreams?.(stream);
      t.direction = 'sendrecv';   // → negotiationneeded
    } else {
      pc.addTrack(track, stream);
    }
  }
}

// ── Remote signaling entry points (called from app.js) ─────────────────────

function handleOffer(fromId, offer, connId) {
  fromId = String(fromId);
  return enqueueSignal(fromId, async () => {
    if (!offer || !connId) return;
    let pc = peerConnections.get(fromId);
    let meta = pc && pcMeta.get(pc);
    const decision = decideOffer(meta ? { connId: meta.connId, isInitiator: meta.isInitiator, connected: isPcConnected(pc) } : null, connId);
    if (decision === 'ignore') return;

    let fresh = false;
    if (decision === 'create' || decision === 'replace') {
      if (isRelayOnly() && !canUseRelay()) {
        if (_onRelayUnavailable) _onRelayUnavailable();
        return;
      }
      await ensureLocalStream();
      if (pc) closePeerConnection(fromId);
      pc = createPeerConnection(fromId, connId, false);
      meta = pcMeta.get(pc);
      fresh = true;
    }

    const polite = !meta.isInitiator;
    const collision = meta.makingOffer || pc.signalingState !== 'stable';
    meta.ignoreOffer = !polite && collision;
    if (meta.ignoreOffer) return;

    await pc.setRemoteDescription(offer);          // implicit rollback when polite
    if (fresh) attachLocalTracks(pc);              // after SRD → reuses offered transceivers
    await pc.setLocalDescription();
    if (!isCurrent(fromId, pc)) return;
    sendSignal('webrtc-answer', fromId, meta.connId, { answer: localDescriptionForWire(pc, meta) });
    await flushCandidates(pc, meta);
  });
}

function handleAnswer(fromId, answer, connId) {
  fromId = String(fromId);
  return enqueueSignal(fromId, async () => {
    const pc = peerConnections.get(fromId);
    const meta = pc && pcMeta.get(pc);
    if (!meta || meta.connId !== connId || !answer) return;      // stale session
    if (pc.signalingState !== 'have-local-offer') return;        // duplicate / late
    await pc.setRemoteDescription(answer);
    await flushCandidates(pc, meta);
  });
}

function handleIceCandidate(fromId, candidate, connId) {
  fromId = String(fromId);
  return enqueueSignal(fromId, async () => {
    const pc = peerConnections.get(fromId);
    const meta = pc && pcMeta.get(pc);
    if (!meta || meta.connId !== connId || !candidate) return;
    if (!pc.remoteDescription) { meta.pendingCandidates.push(candidate); return; }
    try {
      await pc.addIceCandidate(candidate);
    } catch (err) {
      if (!meta.ignoreOffer) console.warn('[webrtc] addIceCandidate failed', err);
    }
  });
}

async function flushCandidates(pc, meta) {
  const list = meta.pendingCandidates.splice(0);
  for (const c of list) {
    try { await pc.addIceCandidate(c); } catch (err) { console.warn('[webrtc] queued candidate failed', err); }
  }
}

// ── Connection health / recovery ───────────────────────────────────────────

function handleConnectionState(peerId, pc) {
  if (!isCurrent(peerId, pc)) return;
  const meta = pcMeta.get(pc);
  const state = pcState(pc);

  if (state === 'connected' || state === 'completed') {
    meta.restartAttempts = 0;
    meta.connectedAt = meta.connectedAt || Date.now();
    clearTimeout(meta.recoveryTimer);
    meta.recoveryTimer = null;
  } else if (state === 'disconnected') {
    scheduleRecovery(peerId, pc, ICE_DISCONNECT_GRACE);
  } else if (state === 'failed') {
    scheduleRecovery(peerId, pc, 0);
  }
  refreshUserList();
}

function scheduleRecovery(peerId, pc, delay) {
  const meta = pcMeta.get(pc);
  if (meta.recoveryTimer) return;
  meta.recoveryTimer = setTimeout(() => {
    meta.recoveryTimer = null;
    recoverPeer(peerId, pc);
  }, delay);
}

function recoverPeer(peerId, pc) {
  if (!isCurrent(peerId, pc) || isPcConnected(pc)) return;
  const meta = pcMeta.get(pc);
  if (typeof isWebSocketOpen === 'function' && !isWebSocketOpen()) {
    // Can't signal right now; try again later (resync also runs on reconnect).
    scheduleRecovery(peerId, pc, ICE_RESTART_TIMEOUT);
    return;
  }
  if (meta.restartAttempts < MAX_ICE_RESTARTS) {
    meta.restartAttempts++;
    console.log(`[webrtc] ICE restart ${meta.restartAttempts}/${MAX_ICE_RESTARTS} for ${peerId}`);
    // Only one side drives the restart; the other side waits for it.
    if (meta.isInitiator) {
      if (pc.restartIce) pc.restartIce();
      else pc.createOffer({ iceRestart: true }).then(o => pc.setLocalDescription(o))
        .then(() => sendSignal('webrtc-offer', peerId, meta.connId, { offer: localDescriptionForWire(pc, meta) }))
        .catch(() => {});
    }
    scheduleRecovery(peerId, pc, ICE_RESTART_TIMEOUT);
    return;
  }
  console.log('[webrtc] rebuilding connection to', peerId);
  connectToPeer(peerId);
}

// Note that `peerId` is (now) a member of our channel.
function notePeer(peerId) {
  peerId = String(peerId);
  if (!peerSeenAt.has(peerId)) peerSeenAt.set(peerId, Date.now());
}

// After a signaling reconnect: rebuild every link that isn't healthy.
function resyncPeers(peerIds) {
  const wanted = new Set(peerIds.map(String));
  for (const id of [...peerConnections.keys()]) if (!wanted.has(id)) forgetPeer(id);
  for (const id of wanted) {
    notePeer(id);
    const pc = peerConnections.get(id);
    const st = pc ? pcState(pc) : null;
    if (!pc || st === 'failed' || st === 'closed' || st === 'disconnected') connectToPeer(id);
  }
}

let _peerListProvider = null;
let _watchdogTimer = null;

function startPeerWatchdog(provider) {
  _peerListProvider = provider;
  if (_watchdogTimer) return;
  _watchdogTimer = setInterval(runWatchdog, WATCHDOG_INTERVAL);
}

function stopPeerWatchdog() {
  clearInterval(_watchdogTimer);
  _watchdogTimer = null;
}

function runWatchdog() {
  if (!_peerListProvider) return;
  if (typeof isWebSocketOpen === 'function' && !isWebSocketOpen()) return;
  const ids = (_peerListProvider() || []).map(String);
  const wanted = new Set(ids);
  const now = Date.now();

  // Drop connections to users who are no longer in our channel.
  for (const id of [...peerConnections.keys()]) if (!wanted.has(id)) forgetPeer(id);
  for (const id of [...peerSeenAt.keys()]) if (!wanted.has(id)) peerSeenAt.delete(id);

  for (const id of ids) {
    notePeer(id);
    const pc = peerConnections.get(id);
    if (!pc) {
      if (now - peerSeenAt.get(id) > PEER_WAIT_BEFORE_WATCHDOG) {
        console.log('[webrtc] watchdog: no connection to', id, '→ connecting');
        connectToPeer(id);
      }
      continue;
    }
    const meta = pcMeta.get(pc);
    const st = pcState(pc);
    if (st === 'closed') connectToPeer(id);
    else if ((st === 'new' || st === 'connecting' || st === 'checking') && !meta.connectedAt &&
             now - meta.createdAt > CONNECT_TIMEOUT) {
      console.log('[webrtc] watchdog: connection to', id, 'stuck in', st, '→ rebuilding');
      connectToPeer(id);
    }
  }
}

// ── Remote media ───────────────────────────────────────────────────────────

function addRemoteStream(peerId, stream) {
  let audio = remoteAudios.get(peerId);
  if (audio && audio.srcObject === stream) return;
  if (!audio) {
    audio = new Audio();
    audio.autoplay = true;
    remoteAudios.set(peerId, audio);
    const savedSpeaker = localStorage.getItem('ezspeak_speaker');
    if (savedSpeaker && audio.setSinkId) audio.setSinkId(savedSpeaker).catch(() => {});
  }
  audio.srcObject = stream;
  applyPeerAudioState(peerId);
  audio.play().catch(() => {
    console.warn('[webrtc] autoplay blocked for ' + peerId + ' — will retry on interaction');
  });
  startSpeakingDetection(peerId, stream, false);
  refreshUserList();
}

function addRemoteVideo(peerId, stream) {
  stream.getVideoTracks().forEach(track => {
    track.addEventListener('ended', () => removeRemoteVideo(peerId));
  });
  stream.onremovetrack = (e) => { if (e.track.kind === 'video') removeRemoteVideo(peerId); };
  remoteVideos.set(peerId, { stream });
  if (_onPeerVideoChange) _onPeerVideoChange(peerId, true);
}

function removeRemoteVideo(peerId) {
  if (!remoteVideos.has(peerId)) return;
  remoteVideos.delete(peerId);
  peerVideoSources.delete(peerId);
  if (_onPeerVideoChange) _onPeerVideoChange(peerId, false);
}

function hasPeerVideo(peerId) { return remoteVideos.has(peerId); }
function getPeerVideoStream(peerId) { return remoteVideos.get(peerId)?.stream || null; }

// ── Local video sharing (camera / screen) ─────────────────────────────────

function onPeerVideoChange(fn) { _onPeerVideoChange = fn; }

function addOrReuseVideoSender(pc, track, stream) {
  // Reuse an idle video transceiver so repeated sharing doesn't grow the SDP.
  const idle = pc.getTransceivers().find(t =>
    !t.stopped && t.receiver.track?.kind === 'video' && !t.sender.track && t.sender.setStreams);
  if (idle) {
    idle.sender.replaceTrack(track).catch(() => {});
    idle.sender.setStreams(stream);
    idle.direction = 'sendrecv';
  } else {
    pc.addTrack(track, stream);
  }
}

function addVideoToAllPeers() {
  if (!localVideoStream) return;
  const track = localVideoStream.getVideoTracks()[0];
  if (!track) return;
  for (const pc of peerConnections.values()) {
    const existing = pc.getSenders().find(s => s.track?.kind === 'video');
    if (existing) existing.replaceTrack(track).catch(() => {});
    else addOrReuseVideoSender(pc, track, localVideoStream);
  }
}

async function startSharingVideo() {
  if (localVideoStream) return true;
  const savedCam = localStorage.getItem('ezspeak_cam');
  const constraints = { video: savedCam ? { deviceId: { exact: savedCam } } : true };
  try {
    localVideoStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    console.warn('[video] camera not available:', e.message);
    return false;
  }
  localVideoSource = 'camera';
  addVideoToAllPeers();
  sendWs({ type: 'video-state-changed', active: true, source: 'camera' });
  if (_onPeerVideoChange) _onPeerVideoChange(userId, true);
  return true;
}

async function startSharingScreen() {
  if (localVideoStream) stopSharingVideo();
  if (!navigator.mediaDevices?.getDisplayMedia) {
    ezAlert('Screen sharing is not supported on this device. It works on desktop Chrome, Firefox, and Edge.');
    return false;
  }
  try {
    localVideoStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  } catch (e) {
    if (e.name !== 'AbortError' && e.name !== 'NotAllowedError') {
      console.warn('[screen] display share error:', e.message);
      ezAlert('Screen sharing failed: ' + (e.message || 'unknown error'));
    }
    return false;
  }
  localVideoSource = 'screen';
  localVideoStream.getVideoTracks().forEach(track => {
    track.addEventListener('ended', () => { if (localVideoSource === 'screen') stopSharingVideo(); });
  });
  addVideoToAllPeers();
  sendWs({ type: 'video-state-changed', active: true, source: 'screen' });
  if (_onPeerVideoChange) _onPeerVideoChange(userId, true);
  return true;
}

function stopSharingVideo() {
  if (!localVideoStream) return;
  for (const pc of peerConnections.values()) {
    if (pc.signalingState === 'closed') continue;
    pc.getSenders().filter(s => s.track?.kind === 'video').forEach(s => {
      try { pc.removeTrack(s); } catch (e) { /* ignore */ }
    });
  }
  localVideoStream.getVideoTracks().forEach(t => t.stop());
  localVideoStream = null;
  localVideoSource = null;
  sendWs({ type: 'video-state-changed', active: false });
  if (_onPeerVideoChange) _onPeerVideoChange(userId, false);
}

function isSharingVideo() { return !!localVideoStream; }
function isSharingScreen() { return !!(localVideoStream && localVideoSource === 'screen'); }
function getPeerVideoSource(peerId) { return peerVideoSources.get(peerId) || null; }

// ── Cleanup ─────────────────────────────────────────────────────────────────

// Close the connection (session) only — keeps per-user volume/mute choices.
function closePeerConnection(peerId) {
  peerId = String(peerId);
  const pc = peerConnections.get(peerId);
  if (pc) {
    const meta = pcMeta.get(pc);
    if (meta) clearTimeout(meta.recoveryTimer);
    peerConnections.delete(peerId);
    pc.onicecandidate = pc.ontrack = pc.ondatachannel = pc.onnegotiationneeded = null;
    pc.onconnectionstatechange = pc.oniceconnectionstatechange = null;
    try { pc.close(); } catch (e) { /* ignore */ }
  }
  const audio = remoteAudios.get(peerId);
  if (audio) {
    audio.pause();
    audio.srcObject = null;
    remoteAudios.delete(peerId);
  }
  removeRemoteVideo(peerId);
  stopSpeakingDetection(peerId);
  const fc = fileChannels.get(peerId);
  if (fc) { try { fc.close(); } catch (e) { /* ignore */ } fileChannels.delete(peerId); }
  refreshUserList();
}

// The peer left our channel / the server: drop everything about them.
function forgetPeer(peerId) {
  peerId = String(peerId);
  closePeerConnection(peerId);
  peerSeenAt.delete(peerId);
  signalQueues.delete(peerId);
  userMuted.delete(peerId);
  userVolume.delete(peerId);
  for (const [fid, info] of pendingFiles) {
    if (info.fromPeer === peerId) pendingFiles.delete(fid);
  }
}

function closeAllPeerConnections() {
  for (const peerId of [...peerConnections.keys()]) forgetPeer(peerId);
  peerSeenAt.clear();
}

function cleanupWebRTC() {
  stopPeerWatchdog();
  stopSharingVideo();
  closeAllPeerConnections();
  remoteAudios.forEach(a => { a.pause(); a.srcObject = null; });
  remoteAudios.clear();
  remoteVideos.clear();
  signalQueues.clear();
}

// ── Debug / test hook ──────────────────────────────────────────────────────

async function getRtcDebugInfo() {
  const out = {};
  for (const [peerId, pc] of peerConnections) {
    const meta = pcMeta.get(pc) || {};
    const info = {
      connId: meta.connId, isInitiator: meta.isInitiator, relayOnly: meta.relayOnly,
      state: pcState(pc), bytesReceived: 0, bytesSent: 0, localCandidateType: null, remoteCandidateType: null,
      remoteAddresses: [],
    };
    try {
      const stats = await pc.getStats();
      const byId = new Map();
      stats.forEach(s => byId.set(s.id, s));
      stats.forEach(s => {
        if (s.type === 'inbound-rtp' && s.kind === 'audio') info.bytesReceived += s.bytesReceived || 0;
        if (s.type === 'outbound-rtp' && s.kind === 'audio') info.bytesSent += s.bytesSent || 0;
        if (s.type === 'remote-candidate') info.remoteAddresses.push(s.address || s.ip || null);
        if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') {
          info.localCandidateType = byId.get(s.localCandidateId)?.candidateType || null;
          info.remoteCandidateType = byId.get(s.remoteCandidateId)?.candidateType || null;
        }
      });
    } catch (e) { /* ignore */ }
    if (pc.remoteDescription) info.remoteSdp = pc.remoteDescription.sdp;
    out[peerId] = info;
  }
  return out;
}

// ── P2P File Transfer (DataChannel) ───────────────────────────────────────

const fileChannels = new Map();
const pendingFiles = new Map();
const fileBlobs = new Map();
const CHUNK_SIZE = 16384;
const FILE_BUFFER_HIGH = 1024 * 1024;   // pause sending above 1 MB buffered
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
  channel.bufferedAmountLowThreshold = FILE_BUFFER_HIGH / 4;
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
  channel.onclose = () => { if (fileChannels.get(peerId) === channel) fileChannels.delete(peerId); };
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
    ezAlert('File is too large for this browser. Please use Chrome for files > 500 MB.');
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
    if (channel.readyState !== 'open') return;   // connection went away
    channel.send(chunkBuf.buffer);
    offset += CHUNK_SIZE;
    if (offset >= file.size) { sendFileComplete(channel, fileId); return; }
    // Backpressure: don't flood the SCTP buffer (would stall voice too).
    if (channel.bufferedAmount > FILE_BUFFER_HIGH) {
      channel.addEventListener('bufferedamountlow', readNext, { once: true });
    } else {
      readNext();
    }
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
