// ── Audio ───────────────────────────────────────────────────────────────────
// Manages local microphone stream, mute/deafen, speaking detection, and beeps.

let audioContext = null;
let localStream = null;
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
  if (audioContext.state === 'suspended') audioContext.resume();
  return audioContext;
}

// --- Microphone stream -------------------------------------------------------

async function ensureLocalStream() {
  if (localStream) return localStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    applyMuteState();
    startSpeakingDetection('__self__', localStream, true);
    return localStream;
  } catch (err) {
    console.error('Microphone access denied:', err);
    alert('Could not access microphone. Please allow microphone access and reload.');
    throw err;
  }
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
  return isMuted;
}

function toggleDeafen() {
  isDeafened = !isDeafened;
  applyMuteState();
  applyDeafenState();
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

// For relay mode — external modules set peer speaking flag directly
function markPeerSpeaking(peerId, speaking) {
  speakingPeers.set(peerId, speaking);
  refreshUserList();
}

// --- Audio recovery (browser autoplay block) ---------------------------------

let audioRecovered = false;

function recoverAudioOnInteraction() {
  if (audioRecovered) return;
  audioRecovered = true;
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') ctx.resume();
  // Re-play all remote audio elements (they were blocked by autoplay policy)
  if (typeof retryAllRemoteAudio === 'function') retryAllRemoteAudio();
  document.removeEventListener('click', recoverAudioOnInteraction);
  document.removeEventListener('touchstart', recoverAudioOnInteraction);
  document.removeEventListener('keydown', recoverAudioOnInteraction);
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
