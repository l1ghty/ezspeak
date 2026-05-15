// ── Settings ────────────────────────────────────────────────────────────────
// Audio/video device selection, permissions display, camera preview.
// Depends on: audio.js (localStream, startSpeakingDetection),
//             webrtc.js (localVideoStream, localVideoSource, peerConnections, remoteAudios)

let previewStream = null;

// ── Open / Close ────────────────────────────────────────────────────────────

async function openSettings() {
  await populateDevices();
  await updatePermissions();
  const modal = document.getElementById('settings-modal');
  modal.style.display = 'flex';
}

function closeSettings() {
  const modal = document.getElementById('settings-modal');
  modal.style.display = 'none';
  stopPreview();
}

function stopPreview() {
  if (previewStream) {
    previewStream.getTracks().forEach(t => t.stop());
    previewStream = null;
  }
  const vid = document.getElementById('settings-cam-preview');
  if (vid) vid.srcObject = null;
}

// ── Device enumeration ──────────────────────────────────────────────────────

async function populateDevices() {
  try {
    // Request permission first so we get device labels
    await navigator.mediaDevices.getUserMedia({ audio: true, video: true }).catch(() => {});
  } catch (_) {}

  const devices = await navigator.mediaDevices.enumerateDevices();
  const savedMic = localStorage.getItem('ezspeak_mic');
  const savedCam = localStorage.getItem('ezspeak_cam');
  const savedSpeaker = localStorage.getItem('ezspeak_speaker');
  const activeMic = getActiveAudioInputId();
  const activeCam = getActiveVideoInputId();

  // Microphone
  const micSelect = document.getElementById('settings-mic-select');
  micSelect.innerHTML = '';
  for (const d of devices.filter(d => d.kind === 'audioinput')) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Microphone ${micSelect.length + 1}`;
    if (d.deviceId === (savedMic || activeMic)) opt.selected = true;
    micSelect.appendChild(opt);
  }
  if (micSelect.options.length === 0) {
    micSelect.innerHTML = '<option>No microphone found</option>';
  }

  // Speaker
  const spkSelect = document.getElementById('settings-speaker-select');
  spkSelect.innerHTML = '';
  for (const d of devices.filter(d => d.kind === 'audiooutput')) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Speaker ${spkSelect.length + 1}`;
    if (d.deviceId === (savedSpeaker || d.deviceId === 'default')) opt.selected = true;
    spkSelect.appendChild(opt);
  }
  if (spkSelect.options.length === 0) {
    spkSelect.innerHTML = '<option>No speaker found</option>';
  }

  // Camera
  const camSelect = document.getElementById('settings-cam-select');
  camSelect.innerHTML = '';
  for (const d of devices.filter(d => d.kind === 'videoinput')) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Camera ${camSelect.length + 1}`;
    if (d.deviceId === (savedCam || activeCam || camSelect.options.length === 0 ? d.deviceId : '')) {
      opt.selected = true;
    }
    camSelect.appendChild(opt);
  }
  if (camSelect.options.length === 0) {
    camSelect.innerHTML = '<option>No camera found</option>';
  }

  // Show preview for selected camera
  const selectedCam = camSelect.value;
  if (selectedCam) updatePreview(selectedCam);
}

function getActiveAudioInputId() {
  if (typeof localStream !== 'undefined' && localStream) {
    const t = localStream.getAudioTracks()[0];
    if (t) return t.getSettings().deviceId;
  }
  return null;
}

function getActiveVideoInputId() {
  if (typeof localVideoStream !== 'undefined' && localVideoStream && typeof localVideoSource !== 'undefined' && localVideoSource === 'camera') {
    const t = localVideoStream.getVideoTracks()[0];
    if (t) return t.getSettings().deviceId;
  }
  return null;
}

// ── Device switching ────────────────────────────────────────────────────────

async function switchMicrophone(deviceId) {
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId } }
    });
    const newTrack = newStream.getAudioTracks()[0];
    if (!newTrack) return;

    // Respect current mute state
    if (typeof isMuted !== 'undefined' && isMuted) {
      newTrack.enabled = false;
    }

    // Replace audio track on all peer connections
    const connections = (typeof peerConnections !== 'undefined') ? peerConnections : new Map();
    for (const [peerId, pc] of connections) {
      const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
      if (sender) {
        try { await sender.replaceTrack(newTrack); } catch (e) { /* ignore */ }
      }
    }

    // Update local audio stream
    if (typeof localStream !== 'undefined' && localStream) {
      localStream.getAudioTracks().forEach(t => t.stop());
    }
    localStream = newStream;

    // Re-init speaking detection
    if (typeof startSpeakingDetection === 'function') {
      startSpeakingDetection('__self__', newStream, true);
    }

    localStorage.setItem('ezspeak_mic', deviceId);
    console.log('[settings] switched microphone to', deviceId);
  } catch (e) {
    console.error('[settings] microphone switch failed:', e);
  }
}

async function switchSpeaker(deviceId) {
  const audios = (typeof remoteAudios !== 'undefined') ? remoteAudios : new Map();
  for (const [peerId, audio] of audios) {
    if (audio.setSinkId) {
      try { await audio.setSinkId(deviceId); } catch (e) { /* ignore */ }
    }
  }
  localStorage.setItem('ezspeak_speaker', deviceId);
}

async function switchCamera(deviceId) {
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId } }
    });
    const newTrack = newStream.getVideoTracks()[0];
    if (!newTrack) return;

    const connections = (typeof peerConnections !== 'undefined') ? peerConnections : new Map();
    for (const [peerId, pc] of connections) {
      const sender = pc.getSenders().find(s => s.track?.kind === 'video');
      if (sender) {
        try { await sender.replaceTrack(newTrack); } catch (e) { /* ignore */ }
      }
    }

    // Update local video stream if currently sharing from camera
    const isSharing = (typeof localVideoStream !== 'undefined' && localVideoStream);
    const srcIsCamera = (typeof localVideoSource !== 'undefined' && localVideoSource === 'camera');
    if (isSharing && srcIsCamera) {
      localVideoStream.getVideoTracks().forEach(t => t.stop());
      localVideoStream = newStream;
    }

    localStorage.setItem('ezspeak_cam', deviceId);
    console.log('[settings] switched camera to', deviceId);
    updatePreview(deviceId);
  } catch (e) {
    console.error('[settings] camera switch failed:', e);
  }
}

// ── Camera preview ──────────────────────────────────────────────────────────

async function updatePreview(deviceId) {
  stopPreview();
  if (!deviceId) return;
  try {
    previewStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId }, width: { ideal: 320 }, height: { ideal: 240 } }
    });
    document.getElementById('settings-cam-preview').srcObject = previewStream;
  } catch (e) {
    console.warn('[settings] preview failed:', e.message);
  }
}

// ── Permissions ─────────────────────────────────────────────────────────────

async function updatePermissions() {
  const micEl = document.getElementById('settings-mic-perm');
  const camEl = document.getElementById('settings-cam-perm');
  const screenEl = document.getElementById('settings-screen-perm');

  // Microphone
  try {
    const mic = await navigator.permissions.query({ name: 'microphone' });
    micEl.textContent = mic.state;
    micEl.className = 'perm-badge perm-' + mic.state;
    mic.addEventListener('change', () => {
      micEl.textContent = mic.state;
      micEl.className = 'perm-badge perm-' + mic.state;
    });
  } catch (e) {
    micEl.textContent = 'unknown';
    micEl.className = 'perm-badge perm-unknown';
  }

  // Camera
  try {
    const cam = await navigator.permissions.query({ name: 'camera' });
    camEl.textContent = cam.state;
    camEl.className = 'perm-badge perm-' + cam.state;
    cam.addEventListener('change', () => {
      camEl.textContent = cam.state;
      camEl.className = 'perm-badge perm-' + cam.state;
    });
  } catch (e) {
    camEl.textContent = 'unknown';
    camEl.className = 'perm-badge perm-unknown';
  }

  // Screen share
  if (navigator.mediaDevices?.getDisplayMedia) {
    screenEl.textContent = 'available';
    screenEl.className = 'perm-badge perm-granted';
  } else {
    screenEl.textContent = 'unavailable';
    screenEl.className = 'perm-badge perm-denied';
  }
}

// ── Event wiring ────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const micSelect = document.getElementById('settings-mic-select');
  const spkSelect = document.getElementById('settings-speaker-select');
  const camSelect = document.getElementById('settings-cam-select');

  if (micSelect) micSelect.addEventListener('change', () => switchMicrophone(micSelect.value));
  if (spkSelect) spkSelect.addEventListener('change', () => switchSpeaker(spkSelect.value));
  if (camSelect) camSelect.addEventListener('change', () => {
    switchCamera(camSelect.value);
    updatePreview(camSelect.value);
  });
});
