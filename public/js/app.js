// ── App entry point ─────────────────────────────────────────────────────────
// Loaded last.  Wires modules together: routing, signaling dispatch,
// global state, event bindings, cleanup, webcam sharing, and video modal.

// ── DOM refs (shared globally for all modules) ──────────────────────────────
const landingPage       = document.getElementById('landing-page');
const serverPage        = document.getElementById('server-page');
const joinForm          = document.getElementById('join-form');
const usernameInput     = document.getElementById('username-input');
const serverInput       = document.getElementById('server-input');
const pwLanding         = document.getElementById('password-input-landing');
const serverNameDisplay = document.getElementById('server-name-display');
const channelList       = document.getElementById('channel-list');
const addChannelSection = document.getElementById('add-channel-section');
const addChannelForm    = document.getElementById('add-channel-form');
const newChannelInput   = document.getElementById('new-channel-input');
const currentChannelTitle = document.getElementById('current-channel-title');
const channelUserCount  = document.getElementById('channel-user-count');
const userList          = document.getElementById('user-list');
const onlineCount       = document.getElementById('online-count');
const muteBtn           = document.getElementById('mute-btn');
const deafenBtn         = document.getElementById('deafen-btn');
const cameraBtn         = document.getElementById('camera-btn');
const screenBtn         = document.getElementById('screen-btn');

// Hide screen share button on unsupported devices (mobile)
if (screenBtn && !navigator.mediaDevices?.getDisplayMedia) {
  screenBtn.style.display = 'none';
}

const renameBtn         = document.getElementById('rename-btn');
const setPwBtn          = document.getElementById('set-pw-btn');
const leaveServerBtn    = document.getElementById('leave-server-btn');
const statusDot         = document.getElementById('status-dot');
const statusText        = document.getElementById('status-text');

const recentModal       = document.getElementById('recent-modal');
const recentList        = document.getElementById('recent-list');
const recentModalClose  = document.getElementById('recent-modal-close');
const recentBtnLanding  = document.getElementById('recent-btn-landing');
const recentBtnSidebar  = document.getElementById('recent-btn-sidebar');

const passwordModal     = document.getElementById('password-modal');
const passwordForm      = document.getElementById('password-form');
const pwModalInput      = document.getElementById('password-modal-input');
const pwError           = document.getElementById('password-error');

const renameModal       = document.getElementById('rename-modal');
const renameForm        = document.getElementById('rename-form');
const renameInput       = document.getElementById('rename-input');

const setPwModal        = document.getElementById('set-pw-modal');
const setPwForm         = document.getElementById('set-pw-form');
const setPwInput        = document.getElementById('set-pw-input');

const chatPanel         = document.getElementById('chat-panel');
const chatMessages      = document.getElementById('chat-messages');
const chatForm          = document.getElementById('chat-form');
const chatInput         = document.getElementById('chat-input');
const fileInput         = document.getElementById('file-input');
const fileSendBtn       = document.getElementById('file-send-btn');
const sidebarToggleBtn  = document.getElementById('sidebar-toggle-btn');
const sidebarCloseBtn   = document.getElementById('sidebar-close-btn');
const sidebarOverlay    = document.getElementById('sidebar-overlay');
const sidebarEl         = document.getElementById('sidebar');

// Video modals — multiple on desktop, single on mobile
const videoModals = new Map();  // peerId → { modal, video }

// ── Global state ────────────────────────────────────────────────────────────
let userId             = null;
let username           = '';
let serverName         = '';
let serverPassword     = '';
let isCreator          = false;
let currentChannel     = null;
let serverState        = null;

function updatePageTitle() {
  const parts = ['ezspeak', serverName];
  if (currentChannel) parts.push(currentChannel);
  document.title = parts.join(' › ');
}

// ── Callback wiring ─────────────────────────────────────────────────────────
onConnectionStatusChange(setConnectionStatus);
onSpeakingChange(() => { if (currentChannel) renderChannelUsers(currentChannel); });

// When a peer starts/stops video, refresh user list + close their modal if open
onPeerVideoChange((peerId, active) => {
  if (currentChannel) renderChannelUsers(currentChannel);
  if (!active) closeVideoModal(String(peerId));
});

// ── URL routing ─────────────────────────────────────────────────────────────
const pathMatch = window.location.pathname.match(/^\/server\/(.+)/);
if (pathMatch) {
  serverName = decodeURIComponent(pathMatch[1]);
  updatePageTitle();
  const params = new URLSearchParams(window.location.search);
  username = params.get('username') || loadSavedUsername();
  serverPassword = sessionStorage.getItem(SS_PASSWORD) || '';
  sessionStorage.removeItem(SS_PASSWORD);
  showServerPage();
} else {
  showLandingPage();
}

function showLandingPage() {
  landingPage.style.display = 'flex';
  serverPage.style.display = 'none';
  if (!usernameInput.value) usernameInput.value = loadSavedUsername();
}

function showServerPage() {
  landingPage.style.display = 'none';
  serverPage.style.display = 'grid';
  serverNameDisplay.textContent = serverName;
  if (!username) username = loadSavedUsername();
  requestWakeLock();
  connectWebSocket(serverName, username, serverPassword, handleSignaling);
}

function navigateToServer(name) {
  saveUsername(usernameInput.value || username);
  window.location.href = `/server/${encodeURIComponent(name)}`;
}

// ── Signaling dispatch ──────────────────────────────────────────────────────

function handleSignaling(msg) {
  switch (msg.type) {

    case '__disconnected':
      stopKeepAlive();
      cleanupAll();
      break;

    case 'server-state':
      userId = msg.yourUserId;
      isCreator = (msg.creator === userId);
      serverState = msg;
      saveUsername(username);
      saveRecentServer(serverName, msg.hasPassword);
      renderChannels(msg.channels);
      updateOnlineCount(msg.users);
      if (isCreator) showCreatorTools();
      serverPassword = '';
      startKeepAlive();
      const first = Object.keys(msg.channels)[0];
      if (first && !currentChannel) joinChannel(first);
      break;

    case 'password-required':
      setConnectionStatus('disconnected', 'Password required');
      closeWs();
      showPasswordModal();
      break;

    case 'user-joined-server':
      if (serverState) {
        serverState.users[msg.userId] = { userId: msg.userId, username: msg.username, channelName: msg.channelName };
        updateOnlineCount(serverState.users);
      }
      break;

    case 'user-left-server':
      if (serverState) {
        delete serverState.users[msg.userId];
        for (const ch of Object.values(serverState.channels)) delete ch.users[msg.userId];
        closePeerConnection(msg.userId);
        closeVideoModal(String(msg.userId));
        renderChannels(serverState.channels);
        updateOnlineCount(serverState.users);
      }
      break;

    case 'user-renamed':
      if (serverState && serverState.users[msg.userId]) {
        serverState.users[msg.userId].username = msg.newUsername;
        for (const ch of Object.values(serverState.channels)) {
          if (ch.users[msg.userId]) ch.users[msg.userId].username = msg.newUsername;
        }
        if (msg.userId === userId) username = msg.newUsername;
        renderChannels(serverState.channels);
        if (currentChannel) renderChannelUsers(currentChannel);
      }
      break;

    case 'password-updated':
      if (serverState) {
        serverState.hasPassword = msg.hasPassword;
        updateRecentServerPassword(serverName, msg.hasPassword);
      }
      break;

    case 'user-channel-update':
      if (serverState) {
        const user = serverState.users[msg.userId];
        if (user) {
          if (user.channelName && serverState.channels[user.channelName])
            delete serverState.channels[user.channelName].users[msg.userId];
          user.channelName = msg.channelName;
          if (msg.channelName && serverState.channels[msg.channelName])
            serverState.channels[msg.channelName].users[msg.userId] = { userId: msg.userId, username: msg.username };
        }
        renderChannels(serverState.channels);
        if (currentChannel) renderChannelUsers(currentChannel);
      }
      break;

    case 'channel-added':
      if (serverState) {
        serverState.channels[msg.channelKey] = { name: msg.channelName, users: {} };
        renderChannels(serverState.channels);
      }
      break;

    case 'joined-channel':
      console.log('[app] joined-channel totalUsers=' + msg.totalUsers + ' peers=' + msg.existingPeers.length);
      currentChannel = msg.channelName;
      updatePageTitle();
      setChannelTitle(serverState?.channels[msg.channelName]?.name || msg.channelName);
      showChat(); clearChat();
      addChatMessage(null, null, `You joined ${serverState?.channels[msg.channelName]?.name || msg.channelName}`, Date.now(), true);
      renderChannelUsers(msg.channelName);
      break;

    case 'peer-joined-channel':
      if (currentChannel === msg.channelName) {
        console.log('[app] peer-joined ' + msg.username + ' totalUsers=' + msg.totalUsers);
        addChatMessage(null, null, `${msg.username} joined the channel`, Date.now(), true);
        playBeep('join');
        if (serverState && serverState.users[msg.userId]) {
          serverState.users[msg.userId].isMuted = msg.isMuted || false;
          serverState.users[msg.userId].isDeafened = msg.isDeafened || false;
        }
        if (!peerConnections.has(msg.userId)) initiateWebRTC(msg.userId);
        renderChannelUsers(currentChannel);
      }
      break;

    case 'peer-left-channel':
      closePeerConnection(msg.userId);
      closeVideoModal(String(msg.userId));
      if (currentChannel === msg.channelName) {
        const peerName = serverState?.users[msg.userId]?.username || msg.username;
        addChatMessage(null, null, `${peerName} left the channel`, Date.now(), true);
        playBeep('leave');
        renderChannelUsers(currentChannel);
      }
      break;

    case 'left-channel':
      closeAllVideoModals();
      currentChannel = null;
      updatePageTitle();
      closeAllPeerConnections();
      setChannelTitle('Not in a channel');
      channelUserCount.textContent = '';
      userList.innerHTML = '<p class="placeholder">Select a channel from the sidebar to start talking</p>';
      hideChat(); clearChat();
      break;

    case 'chat-message':
      addChatMessage(msg.userId, msg.username, msg.message, msg.timestamp);
      break;

    case 'mute-state-changed':
      if (serverState && serverState.users[msg.userId]) {
        serverState.users[msg.userId].isMuted = msg.value;
        if (currentChannel) renderChannelUsers(currentChannel);
      }
      break;

    case 'deafen-state-changed':
      if (serverState && serverState.users[msg.userId]) {
        serverState.users[msg.userId].isDeafened = msg.value;
        if (currentChannel) renderChannelUsers(currentChannel);
      }
      break;

    case 'video-state-changed':
      if (currentChannel) renderChannelUsers(currentChannel);
      // Store peer video source for icon display
      if (msg.active && typeof peerVideoSources !== 'undefined') {
        peerVideoSources.set(String(msg.userId), msg.source || 'camera');
      } else if (!msg.active && typeof peerVideoSources !== 'undefined') {
        peerVideoSources.delete(String(msg.userId));
      }
      if (!msg.active) closeVideoModal(String(msg.userId));
      break;

    case 'file-announce':
      if (typeof pendingFiles !== 'undefined') {
        pendingFiles.set(msg.fileId, {
          name: msg.fileName,
          size: msg.fileSize,
          mimeType: msg.fileType,
          fromPeer: String(msg.userId),
          fromName: msg.username || serverState?.users[msg.userId]?.username || 'Unknown'
        });
      }
      addFileMessage(msg.userId, msg.username || serverState?.users[msg.userId]?.username || 'Unknown',
        msg.fileName, null, msg.fileSize, msg.fileId, false);
      playBeep('join');
      break;

    case 'webrtc-offer':   handleOffer(msg.fromId, msg.offer); break;
    case 'webrtc-answer':  handleAnswer(msg.fromId, msg.answer); break;
    case 'webrtc-ice-candidate': handleIceCandidate(msg.fromId, msg.candidate); break;
    case 'mixer-changed': break;

    case 'error':
      alert('Error: ' + msg.message);
      break;

    default:
      console.log('Unhandled message:', msg.type, msg);
  }
}

// ── Channel join / leave ────────────────────────────────────────────────────

async function joinChannel(channelName) {
  if (currentChannel === channelName) return;
  if (currentChannel) {
    sendWs({ type: 'leave-channel' });
    closeAllPeerConnections();
    closeAllVideoModals();
    playBeep('switch');
  }
  closeSidebar();
  await ensureLocalStream();
  updateMicControls();
  sendWs({ type: 'join-channel', channelName });
  document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
  const items = document.querySelectorAll('.channel-item');
  const names = Object.keys(serverState?.channels || {});
  const idx = names.indexOf(channelName);
  if (idx >= 0 && items[idx]) items[idx].classList.add('active');
}

function leaveServer() {
  if (!confirm('Leave this server?')) return;
  cleanupAll();
  window.location.href = '/';
}

// ── Video modals ────────────────────────────────────────────────────────────

function openVideoModal(peerId) {
  peerId = String(peerId);

  // On mobile, only one modal at a time
  if (window.innerWidth <= 768 && videoModals.size > 0) {
    closeAllVideoModals();
  }

  // Already open? Bring to front
  if (videoModals.has(peerId)) {
    const existing = videoModals.get(peerId);
    existing.modal.style.zIndex = 200 + videoModals.size;
    return;
  }

  const stream = getPeerVideoStream(peerId);
  if (!stream) return;

  const peerName = serverState?.users[peerId]?.username
    || serverState?.channels[currentChannel]?.users[peerId]?.username
    || 'User';

  // Create modal element
  const modal = document.createElement('div');
  modal.className = 'video-modal';
  modal.innerHTML = `
    <div class="video-modal-header">
      <span class="video-modal-title">${escapeHtml(peerName)}'s camera</span>
      <button class="video-modal-fullscreen" title="Fullscreen">⛶</button>
      <button class="video-modal-close" title="Close">✕</button>
    </div>
    <video class="video-modal-video" autoplay playsinline></video>
    <div class="video-modal-resize"></div>
  `;

  const video = modal.querySelector('.video-modal-video');
  video.srcObject = stream;

  // Stagger position from bottom-right
  const count = videoModals.size;
  const baseRight = 16;
  const baseBottom = 72;
  modal.style.right = (baseRight + count * 28) + 'px';
  modal.style.bottom = (baseBottom + count * 28) + 'px';
  modal.style.zIndex = 200 + count;

  // ── Drag ──────────────────────────────────────────────────────────
  const header = modal.querySelector('.video-modal-header');
  let dragInfo = null;

  header.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    const rect = modal.getBoundingClientRect();
    dragInfo = { sx: e.clientX, sy: e.clientY, left: rect.left, top: rect.top };
    modal.style.right = ''; modal.style.bottom = '';
    modal.style.left = rect.left + 'px';
    modal.style.top = rect.top + 'px';
    e.preventDefault();
  });

  header.addEventListener('touchstart', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    const rect = modal.getBoundingClientRect();
    const t = e.touches[0];
    dragInfo = { sx: t.clientX, sy: t.clientY, left: rect.left, top: rect.top };
    modal.style.right = ''; modal.style.bottom = '';
    modal.style.left = rect.left + 'px';
    modal.style.top = rect.top + 'px';
  });

  const onMove = (e) => {
    if (!dragInfo) return;
    const t = e.touches ? e.touches[0] : e;
    modal.style.left = (dragInfo.left + t.clientX - dragInfo.sx) + 'px';
    modal.style.top  = (dragInfo.top  + t.clientY - dragInfo.sy) + 'px';
  };
  const onUp = () => { dragInfo = null; };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('touchmove', onMove);
  document.addEventListener('mouseup', onUp);
  document.addEventListener('touchend', onUp);

  // Store cleanup function to remove listeners on close
  const cleanupDrag = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('touchend', onUp);
  };

  // ── Resize ────────────────────────────────────────────────────────
  const resizeHandle = modal.querySelector('.video-modal-resize');
  let resizeInfo = null;
  const MIN_W = 200, MIN_H = 120;

  resizeHandle.addEventListener('mousedown', (e) => {
    if (document.fullscreenElement === modal) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = modal.getBoundingClientRect();
    resizeInfo = { sx: e.clientX, sy: e.clientY, width: rect.width, height: rect.height };
  });

  resizeHandle.addEventListener('touchstart', (e) => {
    if (document.fullscreenElement === modal) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = modal.getBoundingClientRect();
    const t = e.touches[0];
    resizeInfo = { sx: t.clientX, sy: t.clientY, width: rect.width, height: rect.height };
  });

  const onResizeMove = (e) => {
    if (!resizeInfo) return;
    const t = e.touches ? e.touches[0] : e;
    const w = Math.max(MIN_W, resizeInfo.width + t.clientX - resizeInfo.sx);
    const h = Math.max(MIN_H, resizeInfo.height + t.clientY - resizeInfo.sy);
    modal.style.width = w + 'px';
    modal.style.height = h + 'px';
    // Let video fill available space (header is ~40px)
    video.style.maxHeight = (h - 40) + 'px';
  };
  const onResizeUp = () => { resizeInfo = null; };

  document.addEventListener('mousemove', onResizeMove);
  document.addEventListener('touchmove', onResizeMove, { passive: false });
  document.addEventListener('mouseup', onResizeUp);
  document.addEventListener('touchend', onResizeUp);

  const cleanupResize = () => {
    document.removeEventListener('mousemove', onResizeMove);
    document.removeEventListener('touchmove', onResizeMove);
    document.removeEventListener('mouseup', onResizeUp);
    document.removeEventListener('touchend', onResizeUp);
  };

  // ── Fullscreen ────────────────────────────────────────────────────
  const fsBtn = modal.querySelector('.video-modal-fullscreen');
  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      modal.requestFullscreen();
    }
  });

  // ── Close ─────────────────────────────────────────────────────────
  modal.querySelector('.video-modal-close').addEventListener('click', () => {
    closeVideoModal(peerId);
  });

  document.body.appendChild(modal);
  videoModals.set(peerId, { modal, video, cleanupDrag, cleanupResize });
}

function closeVideoModal(peerId) {
  peerId = String(peerId);
  const entry = videoModals.get(peerId);
  if (!entry) return;

  if (entry.cleanupDrag) entry.cleanupDrag();
  if (entry.cleanupResize) entry.cleanupResize();
  entry.video.srcObject = null;
  entry.modal.remove();
  if (document.fullscreenElement === entry.modal) {
    try { document.exitFullscreen(); } catch (e) { /* ignore */ }
  }
  videoModals.delete(peerId);
}

function closeAllVideoModals() {
  for (const peerId of videoModals.keys()) {
    closeVideoModal(peerId);
  }
}

// ── Camera / Screen share buttons ─────────────────────────────────────────

cameraBtn.addEventListener('click', async () => {
  if (isSharingVideo()) {
    stopSharingVideo();
    updateShareButtons();
  } else {
    const started = await startSharingVideo();
    if (started) updateShareButtons();
  }
});

screenBtn.addEventListener('click', async () => {
  if (isSharingScreen()) {
    stopSharingVideo();
    updateShareButtons();
  } else {
    const started = await startSharingScreen();
    if (started) updateShareButtons();
  }
});

function updateShareButtons() {
  const sharing = isSharingVideo();
  const isScreen = isSharingScreen();
  cameraBtn.classList.toggle('active', sharing && !isScreen);
  cameraBtn.querySelector('.icon').textContent = sharing && !isScreen ? '📸' : '📹';
  cameraBtn.querySelector('.label').textContent = sharing && !isScreen ? 'Sharing' : 'Camera';
  screenBtn.classList.toggle('active', isScreen);
  screenBtn.querySelector('.icon').textContent = isScreen ? '🖥️' : '🖥️';
  screenBtn.querySelector('.label').textContent = isScreen ? 'Sharing' : 'Screen';
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

function cleanupAll() {
  releaseWakeLock();
  stopSharingVideo();
  closeAllVideoModals();
  cleanupWebRTC();
  cleanupAudio();
  currentChannel = null;
  serverState = null;
  closeWs();
}

// ── Wake Lock ───────────────────────────────────────────────────────────────

let wakeLock = null;

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (e) { /* not supported or denied */ }
}

async function releaseWakeLock() {
  if (wakeLock) {
    try { await wakeLock.release(); } catch (e) { /* ignore */ }
    wakeLock = null;
  }
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    await requestWakeLock();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }
});

// ── WebSocket keep-alive ────────────────────────────────────────────────────

let keepAliveInterval = null;

function startKeepAlive() {
  stopKeepAlive();
  keepAliveInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 25000);
}

function stopKeepAlive() {
  if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null; }
}

// ── Event listeners ─────────────────────────────────────────────────────────

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = usernameInput.value.trim();
  const server = serverInput.value.trim().toLowerCase().replace(/\s+/g, '-');
  const pw = pwLanding.value;
  if (!name || !server) return;
  saveUsername(name);
  if (pw) sessionStorage.setItem(SS_PASSWORD, pw);
  navigateToServer(server);
});

recentBtnLanding.addEventListener('click', showRecentModal);
recentBtnSidebar.addEventListener('click', showRecentModal);
recentModalClose.addEventListener('click', hideRecentModal);
recentModal.addEventListener('click', (e) => { if (e.target === recentModal) hideRecentModal(); });

passwordForm.addEventListener('submit', (e) => {
  e.preventDefault();
  serverPassword = pwModalInput.value.trim();
  if (!serverPassword) return;
  hidePasswordModal();
  connectWebSocket(serverName, username, serverPassword, handleSignaling);
});
passwordModal.addEventListener('click', (e) => { if (e.target === passwordModal) hidePasswordModal(); });

renameBtn.addEventListener('click', showRenameModal);
renameForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const newName = renameInput.value.trim();
  if (!newName || newName === username) { hideRenameModal(); return; }
  saveUsername(newName);
  sendWs({ type: 'change-username', username: newName });
  hideRenameModal();
});
renameModal.addEventListener('click', (e) => { if (e.target === renameModal) hideRenameModal(); });

setPwBtn.addEventListener('click', showSetPwModal);
setPwForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const pw = setPwInput.value.trim();
  sendWs({ type: 'set-password', password: pw || null });
  hideSetPwModal();
});
setPwModal.addEventListener('click', (e) => { if (e.target === setPwModal) hideSetPwModal(); });

addChannelForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = newChannelInput.value.trim();
  if (!name) return;
  sendWs({ type: 'add-channel', channelName: name });
  newChannelInput.value = '';
});

muteBtn.addEventListener('click', () => {
  if (!hasLocalStream()) {
    ensureLocalStream().then(s => { if (s) updateMicControls(); });
    return;
  }
  const muted = toggleMute();
  muteBtn.classList.toggle('active', muted);
  muteBtn.querySelector('.label').textContent = muted ? 'Muted' : 'Mute';
  muteBtn.querySelector('.icon').textContent = muted ? '🤐' : '🎙️';
});

deafenBtn.addEventListener('click', () => {
  if (!hasLocalStream()) return;
  const deafened = toggleDeafen();
  deafenBtn.classList.toggle('active', deafened);
  deafenBtn.querySelector('.label').textContent = deafened ? 'Deafened' : 'Deafen';
  deafenBtn.querySelector('.icon').textContent = deafened ? '🔇' : '🔊';
});

function updateMicControls() {
  const hasMic = hasLocalStream();
  muteBtn.querySelector('.icon').textContent = hasMic ? '🎙️' : '🎤✕';
  muteBtn.querySelector('.label').textContent = hasMic ? 'Mute' : 'No mic';
  muteBtn.classList.toggle('no-mic', !hasMic);
  deafenBtn.style.display = hasMic ? '' : 'none';
}

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  sendChatMessage();
});

fileSendBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (!file) return;
  announceFile(file);
  fileInput.value = '';
});

onFileReceived((peerId, peerName, fileName, blob, size, fileId, isOutgoing) => {
  addFileMessage(peerId, peerName, fileName, blob, size, fileId, isOutgoing);
  if (!isOutgoing) playBeep('join');
});

leaveServerBtn.addEventListener('click', leaveServer);
document.getElementById('leave-server-btn-mobile')?.addEventListener('click', leaveServer);

// ── Sidebar toggle (mobile) ────────────────────────────────────────────

function openSidebar() {
  sidebarEl.classList.add('open');
  sidebarOverlay.classList.add('show');
}

function closeSidebar() {
  sidebarEl.classList.remove('open');
  sidebarOverlay.classList.remove('show');
}

sidebarToggleBtn.addEventListener('click', openSidebar);
sidebarCloseBtn.addEventListener('click', closeSidebar);
sidebarOverlay.addEventListener('click', closeSidebar);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (videoModals.size > 0 && !document.fullscreenElement) {
      closeAllVideoModals();
      return;
    }
    if (recentModal.style.display === 'flex') hideRecentModal();
    if (passwordModal.style.display === 'flex') hidePasswordModal();
    if (renameModal.style.display === 'flex') hideRenameModal();
    if (setPwModal.style.display === 'flex') hideSetPwModal();
  }
});

window.addEventListener('beforeunload', () => {
  cleanupAll();
});
