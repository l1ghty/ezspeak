// ── Audio ───────────────────────────────────────────────────────────────────
// Manages local microphone stream, mute/deafen, speaking detection, and beeps.

let audioContext = null;
let localStream = undefined;  // undefined = not tried yet, null = denied, stream = granted
let isMuted = false;
let isDeafened = false;

// Speaking detection
const speakingPeers = new Map();   // peerId → boolean
const analysers = new Map();       // peerId → { source, analyser, interval }
let localSpeaking = false;

// Volume threshold for "speaking"
const SPEAK_THRESHOLD = 8;

// --- AudioContext ------------------------------------------------------------

function getAudioContext() {
  if (!audioContext) audioContext = new AudioContext();
  return audioContext;
}

async function ensureAudioRunning() {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }
  return ctx;
}

// --- Microphone stream -------------------------------------------------------

async function ensureLocalStream() {
  if (localStream) return localStream;
  if (localStream === null) return null;  // already tried and denied
  console.log('[audio] ensureLocalStream: requesting mic...');
  try {
    const savedMic = localStorage.getItem('ezspeak_mic');
    const constraints = { audio: true, video: false };
    if (savedMic) constraints.audio = { deviceId: { exact: savedMic } };
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    console.log('[audio] mic acquired, tracks=' + localStream.getAudioTracks().length);
    applyMuteState();
    startSpeakingDetection('__self__', localStream, true);
    return localStream;
  } catch (err) {
    console.warn('[audio] microphone not available:', err.message);
    localStream = null;  // mark as denied, don't retry
    return null;
  }
}

function hasLocalStream() {
  return !!localStream;
}

function getLocalStream() {
  return localStream;
}

// --- Mute / Deafen -----------------------------------------------------------

function applyMuteState() {
  if (localStream) {
    localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
  }
}

function applyDeafenState() {
  // remoteAudios lives in webrtc.js — set by external caller
  if (typeof updateRemoteAudioMutes === 'function') updateRemoteAudioMutes(isDeafened);
}

function toggleMute() {
  isMuted = !isMuted;
  applyMuteState();
  // Broadcast to channel so others see the mute indicator
  if (typeof sendWs === 'function') {
    sendWs({ type: 'mute-state-changed', value: isMuted });
  }
  return isMuted;
}

function toggleDeafen() {
  isDeafened = !isDeafened;
  applyMuteState();
  applyDeafenState();
  // Broadcast to channel so others see the deafen indicator
  if (typeof sendWs === 'function') {
    sendWs({ type: 'deafen-state-changed', value: isDeafened });
  }
  return isDeafened;
}

// --- Speaking detection ------------------------------------------------------

function startSpeakingDetection(peerId, stream, isLocal) {
  stopSpeakingDetection(peerId);
  const ctx = getAudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  const dataArray = new Uint8Array(analyser.frequencyBinCount);

  const interval = setInterval(() => {
    analyser.getByteFrequencyData(dataArray);
    const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
    const speaking = avg > SPEAK_THRESHOLD;
    if (isLocal) {
      if (localSpeaking !== speaking) { localSpeaking = speaking; refreshUserList(); }
    } else {
      if (speakingPeers.get(peerId) !== speaking) {
        speakingPeers.set(peerId, speaking);
        refreshUserList();
      }
    }
  }, 120);

  analysers.set(peerId, { source, analyser, interval });
  if (!isLocal) speakingPeers.set(peerId, false);
}

function stopSpeakingDetection(peerId) {
  const entry = analysers.get(peerId);
  if (entry) {
    clearInterval(entry.interval);
    try { entry.source.disconnect(); } catch (e) { /* ignore */ }
    analysers.delete(peerId);
  }
  speakingPeers.delete(peerId);
}

function isPeerSpeaking(peerId) {
  return speakingPeers.get(peerId) || false;
}

function isSelfSpeaking() {
  return localSpeaking;
}

// Called by ui.js after rendering — wires up the refresh callback.
let _refreshUserList = null;
function onSpeakingChange(fn) { _refreshUserList = fn; }
function refreshUserList() { if (_refreshUserList) _refreshUserList(); }

// --- Audio recovery (browser autoplay block) ---------------------------------

let audioRecovered = false;

function recoverAudioOnInteraction() {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') ctx.resume();
  if (typeof retryAllRemoteAudio === 'function') retryAllRemoteAudio();
  if (typeof retryAllRelayAudio === 'function') retryAllRelayAudio();
}

document.addEventListener('click', recoverAudioOnInteraction);
document.addEventListener('touchstart', recoverAudioOnInteraction);
document.addEventListener('keydown', recoverAudioOnInteraction);

// --- Sound effects -----------------------------------------------------------

function playBeep(type) {
  try {
    const ctx = getAudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    const now = ctx.currentTime;

    if (type === 'join') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(523, now);
      osc.frequency.linearRampToValueAtTime(659, now + 0.08);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      osc.start(now); osc.stop(now + 0.22);
    } else if (type === 'leave') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.linearRampToValueAtTime(330, now + 0.12);
      gain.gain.setValueAtTime(0.10, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
      osc.start(now); osc.stop(now + 0.28);
    } else if (type === 'switch') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587, now);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.connect(gain2); gain2.connect(ctx.destination);
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(784, now + 0.06);
      gain2.gain.setValueAtTime(0.001, now);
      gain2.gain.setValueAtTime(0.08, now + 0.06);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      osc.start(now); osc.stop(now + 0.06);
      osc2.start(now + 0.06); osc2.stop(now + 0.18);
    }
  } catch (e) { /* ignore audio errors */ }
}

// --- Cleanup -----------------------------------------------------------------

function cleanupAudio() {
  stopSpeakingDetection('__self__');
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  analysers.forEach(e => { clearInterval(e.interval); try { e.source.disconnect(); } catch (_) {} });
  analysers.clear();
  speakingPeers.clear();
  localSpeaking = false;
  isMuted = false;
  isDeafened = false;
}
