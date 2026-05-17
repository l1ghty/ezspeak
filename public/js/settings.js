// ── Settings ────────────────────────────────────────────────────────────────
// Audio/video device selection, permissions display, camera preview.
// Depends on: audio.js (localStream, startSpeakingDetection),
//             webrtc.js (localVideoStream, localVideoSource, peerConnections, remoteAudios)

let previewStream = null;

// ── Open / Close ────────────────────────────────────────────────────────────

async function openSettings() {
  const modal = document.getElementById('settings-modal');
  const body = modal.querySelector('.modal-body');

  // Show modal immediately with loading spinner
  body.innerHTML = '<div class="settings-loading"><div class="spinner"></div><p>Loading devices…</p></div>';
  modal.style.display = 'flex';

  // Restore real content
  body.innerHTML = `
    <div class="settings-section">
      <h4>🎙️ Audio</h4>
      <div class="settings-row">
        <label for="settings-mic-select">Microphone</label>
        <select id="settings-mic-select"></select>
      </div>
      <div class="mic-test">
        <span class="mic-meter-label">Input level</span>
        <div class="mic-meter">
          <div class="mic-meter-fill" id="mic-meter-fill"></div>
        </div>
        <div class="mic-test-actions">
          <button id="mic-test-monitor" class="btn-small">🔊 Hear myself</button>
          <button id="mic-test-record" class="btn-small">⏺️ Record 3s</button>
        </div>
        <audio id="mic-test-playback" style="display:none"></audio>
      </div>
      <div class="settings-row">
        <label for="settings-speaker-select">Speaker</label>
        <select id="settings-speaker-select"></select>
      </div>
      <p class="settings-hint">Speaker selection works in Chrome &amp; Edge.</p>
    </div>
    <div class="settings-section">
      <h4>📹 Video</h4>
      <div class="settings-row">
        <label for="settings-cam-select">Camera</label>
        <select id="settings-cam-select"></select>
      </div>
      <div id="settings-cam-preview-container">
        <video id="settings-cam-preview" autoplay playsinline muted></video>
      </div>
    </div>
    <div class="settings-section">
      <h4>🖼️ Avatar</h4>
      <div class="avatar-upload" id="avatar-upload-area">
        <div class="avatar-preview-lg" id="settings-avatar-preview">
          <span id="settings-avatar-initial">?</span>
        </div>
        <div class="avatar-actions">
          <button id="settings-avatar-upload" class="btn-small">📁 Choose image</button>
          <button id="settings-avatar-remove" class="btn-small" style="display:none">✕ Remove</button>
        </div>
        <input type="file" id="settings-avatar-input" accept="image/*" style="display:none">
      </div>
      <div class="avatar-cropper" id="avatar-cropper" style="display:none">
        <p class="cropper-hint">Drag image to position</p>
        <div class="cropper-stage" id="cropper-stage">
          <img id="cropper-image" draggable="false">
          <div class="cropper-mask"></div>
        </div>
        <div class="cropper-actions">
          <button id="cropper-cancel" class="btn-small">Cancel</button>
          <button id="cropper-save" class="btn-primary">Crop &amp; Save</button>
        </div>
      </div>
    </div>
    <div class="settings-section">
      <h4>🔐 Permissions</h4>
      <div class="settings-row">
        <span>Microphone</span>
        <span id="settings-mic-perm" class="perm-badge">...</span>
      </div>
      <div class="settings-row">
        <span>Camera</span>
        <span id="settings-cam-perm" class="perm-badge">...</span>
      </div>
      <div class="settings-row">
        <span>Screen Share</span>
        <span id="settings-screen-perm" class="perm-badge">...</span>
      </div>
      <p class="settings-hint">Change permissions via the 🔒 lock icon in your address bar, then click the permission you want to adjust.</p>
      <button id="settings-reset-perms" class="btn-small">🔄 Re-request permissions</button>
    </div>
  `;

  // Re-wire event listeners
  const micSelect = document.getElementById('settings-mic-select');
  const spkSelect = document.getElementById('settings-speaker-select');
  const camSelect = document.getElementById('settings-cam-select');
  if (micSelect) micSelect.addEventListener('change', () => switchMicrophone(micSelect.value));
  if (spkSelect) spkSelect.addEventListener('change', () => switchSpeaker(spkSelect.value));
  if (camSelect) camSelect.addEventListener('change', () => {
    switchCamera(camSelect.value);
    updatePreview(camSelect.value);
  });
  document.getElementById('settings-reset-perms')?.addEventListener('click', resetPermissions);

  // Avatar
  loadAvatarPreview();
  document.getElementById('settings-avatar-upload')?.addEventListener('click', () => {
    document.getElementById('settings-avatar-input').click();
  });
  document.getElementById('settings-avatar-input')?.addEventListener('change', handleAvatarUpload);
  document.getElementById('settings-avatar-remove')?.addEventListener('click', removeAvatar);
  document.getElementById('cropper-save')?.addEventListener('click', saveCrop);
  document.getElementById('cropper-cancel')?.addEventListener('click', closeCropper);

  // Microphone test
  document.getElementById('mic-test-monitor')?.addEventListener('click', toggleMicMonitor);
  document.getElementById('mic-test-record')?.addEventListener('click', testMicRecording);
  startMicMeter();

  // Populate asynchronously
  await populateDevices();
  await updatePermissions();
}

function closeSettings() {
  const modal = document.getElementById('settings-modal');
  modal.style.display = 'none';
  stopPreview();
  stopMicMeter();
  stopMicMonitor();
  if (micTestStream && micTestStream !== (typeof localStream !== 'undefined' ? localStream : null)) {
    micTestStream.getTracks().forEach(t => t.stop());
  }
  micTestStream = null;
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
  // Request permission first so we get device labels
  let tempStream = null;
  try {
    tempStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
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
  let wantedCam = savedCam || activeCam || null;
  // If no saved/active camera, find the front-facing one
  if (!wantedCam) {
    const frontCam = devices.find(d => d.kind === 'videoinput' && (d.label || '').toLowerCase().includes('front'));
    if (frontCam) wantedCam = frontCam.deviceId;
  }
  let hasSelection = false;
  for (const d of devices.filter(d => d.kind === 'videoinput')) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Camera ${camSelect.length + 1}`;
    if (d.deviceId === wantedCam || (!hasSelection && !wantedCam)) {
      opt.selected = true;
      hasSelection = true;
    }
    camSelect.appendChild(opt);
  }
  if (camSelect.options.length === 0) {
    camSelect.innerHTML = '<option>No camera found</option>';
  }

  // Show preview for selected camera
  const selectedCam = camSelect.value;
  if (selectedCam) updatePreview(selectedCam);

  // Release temp permission stream
  if (tempStream) {
    tempStream.getTracks().forEach(t => t.stop());
  }
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

    // Refresh mic controls
    if (typeof updateMicControls === 'function') updateMicControls();

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

async function resetPermissions() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    stream.getTracks().forEach(t => t.stop());
  } catch (e) { /* denied */ }
  await populateDevices();
  await updatePermissions();
}

// ── Avatar ──────────────────────────────────────────────────────────────────

let myAvatar = localStorage.getItem('ezspeak_avatar') || null;

// Send avatar to server when it changes
function broadcastAvatar() {
  if (typeof sendWs === 'function') {
    sendWs({ type: 'avatar-changed', avatar: myAvatar || null });
  }
}

function loadAvatarPreview() {
  const preview = document.getElementById('settings-avatar-preview');
  const initial = document.getElementById('settings-avatar-initial');
  const removeBtn = document.getElementById('settings-avatar-remove');
  if (!preview) return;

  if (myAvatar) {
    preview.style.backgroundImage = `url(${myAvatar})`;
    preview.style.backgroundSize = 'cover';
    preview.style.backgroundPosition = 'center';
    if (initial) initial.style.display = 'none';
    if (removeBtn) removeBtn.style.display = '';
  } else {
    preview.style.backgroundImage = '';
    if (initial) {
      initial.style.display = '';
      initial.textContent = (typeof username !== 'undefined' ? username : '?')[0].toUpperCase();
    }
    if (removeBtn) removeBtn.style.display = 'none';
  }
}

let cropperImg = null;
let cropperOffX = 0, cropperOffY = 0, cropperScale = 1;
let cropperDragging = false, cropperStartX = 0, cropperStartY = 0;
let cropperInitX = 0, cropperInitY = 0;
let cropperTouches = new Map();
let cropperPinchStartDist = 0;
let cropperPinchStartScale = 1;
let cropperPinchMidX = 0, cropperPinchMidY = 0;

function handleAvatarUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      openCropper(img);
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
  e.target.value = '';
}

function openCropper(img) {
  cropperImg = img;
  const stage = document.getElementById('cropper-stage');
  const cropImg = document.getElementById('cropper-image');

  // Size: stage is 280x280 square, mask is a circle covering it
  const size = 280;
  const minDim = Math.min(img.naturalWidth, img.naturalHeight);
  cropperScale = size / minDim;

  // Center the image in the stage
  const w = img.naturalWidth * cropperScale;
  const h = img.naturalHeight * cropperScale;
  cropperOffX = (size - w) / 2;
  cropperOffY = (size - h) / 2;

  cropImg.src = img.src;
  cropImg.style.width = w + 'px';
  cropImg.style.height = h + 'px';
  applyCropperTransform();

  document.getElementById('avatar-upload-area').style.display = 'none';
  document.getElementById('avatar-cropper').style.display = '';

  // Drag events (pointer)
  stage.onpointerdown = (e) => {
    cropperTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (cropperTouches.size >= 2) {
      // Start pinch
      const pts = [...cropperTouches.values()];
      const dx = pts[0].x - pts[1].x;
      const dy = pts[0].y - pts[1].y;
      cropperPinchStartDist = Math.sqrt(dx * dx + dy * dy);
      cropperPinchStartScale = cropperScale;
      cropperPinchMidX = (pts[0].x + pts[1].x) / 2;
      cropperPinchMidY = (pts[0].y + pts[1].y) / 2;
      cropperDragging = false;
      e.preventDefault();
      return;
    }
    cropperDragging = true;
    cropperStartX = e.clientX;
    cropperStartY = e.clientY;
    cropperInitX = cropperOffX;
    cropperInitY = cropperOffY;
    stage.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  stage.onpointermove = (e) => {
    cropperTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (cropperTouches.size >= 2) {
      // Pinch zoom
      const pts = [...cropperTouches.values()];
      const dx = pts[0].x - pts[1].x;
      const dy = pts[0].y - pts[1].y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (cropperPinchStartDist > 0) {
        const newScale = cropperPinchStartScale * (dist / cropperPinchStartDist);
        applyZoom(newScale, cropperPinchMidX, cropperPinchMidY);
      }
      e.preventDefault();
      return;
    }
    if (!cropperDragging) return;
    cropperOffX = cropperInitX + (e.clientX - cropperStartX);
    cropperOffY = cropperInitY + (e.clientY - cropperStartY);
    applyCropperTransform();
  };
  stage.onpointerup = stage.onpointerleave = (e) => {
    cropperTouches.delete(e.pointerId);
    if (cropperTouches.size < 2) {
      cropperPinchStartDist = 0;
    }
    if (cropperTouches.size === 0) {
      cropperDragging = false;
    }
  };

  // Wheel zoom (desktop)
  stage.onwheel = (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.05 : 0.05;
    applyZoom(cropperScale + delta, e.clientX, e.clientY);
  };
}

function applyCropperTransform() {
  const cropImg = document.getElementById('cropper-image');
  if (cropImg) {
    cropImg.style.transform = `translate(${cropperOffX}px, ${cropperOffY}px)`;
  }
}

function applyZoom(newScale, midX, midY) {
  if (!cropperImg) return;
  newScale = Math.max(0.3, Math.min(3, newScale));
  const stage = document.getElementById('cropper-stage');
  const rect = stage.getBoundingClientRect();
  const mx = midX - rect.left;
  const my = midY - rect.top;
  const ratio = newScale / cropperScale;
  cropperOffX = mx - (mx - cropperOffX) * ratio;
  cropperOffY = my - (my - cropperOffY) * ratio;
  cropperScale = newScale;
  const cropImg = document.getElementById('cropper-image');
  const w = cropperImg.naturalWidth * cropperScale;
  const h = cropperImg.naturalHeight * cropperScale;
  cropImg.style.width = w + 'px';
  cropImg.style.height = h + 'px';
  applyCropperTransform();
}

function saveCrop() {
  if (!cropperImg) return;
  const canvas = document.createElement('canvas');
  const outSize = 256;
  canvas.width = outSize;
  canvas.height = outSize;
  const ctx = canvas.getContext('2d');

  // Circular clip
  ctx.beginPath();
  ctx.arc(outSize / 2, outSize / 2, outSize / 2, 0, Math.PI * 2);
  ctx.clip();

  // Map stage (280px) → source image coords
  const stageSize = 280;
  const srcX = -cropperOffX / cropperScale;
  const srcY = -cropperOffY / cropperScale;
  const srcSize = stageSize / cropperScale;

  ctx.drawImage(cropperImg, srcX, srcY, srcSize, srcSize, 0, 0, outSize, outSize);

  myAvatar = canvas.toDataURL('image/jpeg', 0.85);
  localStorage.setItem('ezspeak_avatar', myAvatar);
  closeCropper();
  loadAvatarPreview();
  broadcastAvatar();
  if (typeof refreshUserList === 'function') refreshUserList();
}

function closeCropper() {
  cropperImg = null;
  cropperDragging = false;
  cropperTouches.clear();
  cropperPinchStartDist = 0;
  document.getElementById('avatar-upload-area').style.display = '';
  document.getElementById('avatar-cropper').style.display = 'none';
}

function removeAvatar() {
  myAvatar = null;
  localStorage.removeItem('ezspeak_avatar');
  loadAvatarPreview();
  broadcastAvatar();
  if (typeof refreshUserList === 'function') refreshUserList();
}

function getMyAvatar() {
  return myAvatar;
}

// ── Microphone test ─────────────────────────────────────────────────────────

let micMeterRaf = null;
let micTestCtx = null;
let micTestAnalyser = null;
let micTestSource = null;
let micMonitorGain = null;
let micMonitorActive = false;
let micTestStream = null;

async function getMicTestStream() {
  if (micTestStream) return micTestStream;
  // Reuse existing mic stream if available
  if (typeof localStream !== 'undefined' && localStream) {
    micTestStream = localStream;
    return micTestStream;
  }
  try {
    const savedMic = localStorage.getItem('ezspeak_mic');
    const constraints = { audio: true };
    if (savedMic) constraints.audio = { deviceId: { exact: savedMic } };
    micTestStream = await navigator.mediaDevices.getUserMedia(constraints);
    return micTestStream;
  } catch (e) {
    return null;
  }
}

function startMicMeter() {
  stopMicMeter();
  getMicTestStream().then(stream => {
    if (!stream) return;
    micTestCtx = new AudioContext();
    micTestSource = micTestCtx.createMediaStreamSource(stream);
    micTestAnalyser = micTestCtx.createAnalyser();
    micTestAnalyser.fftSize = 256;
    micTestSource.connect(micTestAnalyser);

    const fill = document.getElementById('mic-meter-fill');
    if (!fill) return;
    const dataArray = new Uint8Array(micTestAnalyser.frequencyBinCount);

    function update() {
      micTestAnalyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      const pct = Math.min(100, Math.round((avg / 128) * 100));
      fill.style.width = pct + '%';
      // Color: green → yellow → red
      if (pct < 50) fill.style.background = 'var(--accent)';
      else if (pct < 80) fill.style.background = '#fbbf24';
      else fill.style.background = 'var(--danger)';
      micMeterRaf = requestAnimationFrame(update);
    }
    update();
  });
}

function stopMicMeter() {
  if (micMeterRaf) { cancelAnimationFrame(micMeterRaf); micMeterRaf = null; }
  if (micTestSource) { try { micTestSource.disconnect(); } catch(e) {} micTestSource = null; }
  if (micTestCtx) { micTestCtx.close(); micTestCtx = null; }
  micTestAnalyser = null;
  const fill = document.getElementById('mic-meter-fill');
  if (fill) { fill.style.width = '0%'; fill.style.background = 'var(--accent)'; }
}

function toggleMicMonitor() {
  const btn = document.getElementById('mic-test-monitor');
  if (micMonitorActive) {
    stopMicMonitor();
    if (btn) { btn.textContent = '🔊 Hear myself'; btn.classList.remove('active'); }
  } else {
    startMicMonitor();
    if (btn) { btn.textContent = '🔇 Stop monitoring'; btn.classList.add('active'); }
  }
}

function startMicMonitor() {
  getMicTestStream().then(stream => {
    if (!stream) return;
    if (!micTestCtx || micTestCtx.state === 'closed') {
      micTestCtx = new AudioContext();
    }
    micMonitorGain = micTestCtx.createGain();
    micMonitorGain.gain.value = 0.5;
    const src = micTestCtx.createMediaStreamSource(stream);
    src.connect(micMonitorGain);
    micMonitorGain.connect(micTestCtx.destination);
    // Store source for cleanup
    micMonitorSource = src;
    micMonitorActive = true;
  });
}

function stopMicMonitor() {
  if (micMonitorSource) { try { micMonitorSource.disconnect(); } catch(e) {} micMonitorSource = null; }
  if (micMonitorGain) { try { micMonitorGain.disconnect(); } catch(e) {} micMonitorGain = null; }
  micMonitorActive = false;
}

let micMonitorSource = null;

async function testMicRecording() {
  const btn = document.getElementById('mic-test-record');
  const playback = document.getElementById('mic-test-playback');
  if (!btn || !playback) return;

  const stream = await getMicTestStream();
  if (!stream) return;

  btn.disabled = true;
  btn.textContent = '⏺️ Recording...';

  const chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: 'audio/webm' });
    playback.src = URL.createObjectURL(blob);
    playback.style.display = '';
    playback.play();
    btn.disabled = false;
    btn.textContent = '▶️ Play again';
    btn.onclick = () => { playback.currentTime = 0; playback.play(); };
  };

  recorder.start();
  setTimeout(() => {
    if (recorder.state === 'recording') recorder.stop();
  }, 3000);
}

