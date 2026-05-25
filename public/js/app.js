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
const shareBtn         = document.getElementById('share-btn');
const shareModal       = document.getElementById('share-modal');
const shareModalClose  = document.getElementById('share-modal-close');
const qrCodeCanvas     = document.getElementById('qr-code-canvas');
const shareUrlInput    = document.getElementById('share-url-input');
const shareCopyBtn     = document.getElementById('share-copy-btn');
const shareNativeBtn   = document.getElementById('share-native-btn');
const scanVideo        = document.getElementById('scan-video');
const scanCanvas       = document.getElementById('scan-canvas');
const scanStatus       = document.getElementById('scan-status');
const scanResult       = document.getElementById('scan-result');
const scanOpenBtn      = document.getElementById('scan-open-btn');
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
const setPwBtnHeader    = document.getElementById('set-pw-btn-header');
const leaveServerBtn    = document.getElementById('leave-server-btn');
const statusDot         = document.getElementById('status-dot');
const statusText        = document.getElementById('status-text');

const recentModal       = document.getElementById('recent-modal');
const recentList        = document.getElementById('recent-list');
const recentModalClose  = document.getElementById('recent-modal-close');

const installBtn        = document.getElementById('install-btn');
const installBtnHeader  = document.getElementById('install-btn-header');
const onlineCountEl     = document.getElementById('online-count');
const selfView          = document.getElementById('self-view');
const selfViewContainer = document.getElementById('self-view-container');
const selfViewToggle    = document.getElementById('self-view-toggle');
const selfViewDragHandle = document.getElementById('self-view-drag-handle');

// Detect if already installed (standalone display mode)
const isInstalled = window.matchMedia('(display-mode: standalone)').matches;

function showInstallButtons() {
  [installBtn, installBtnHeader].forEach(btn => { if (btn) btn.style.display = ''; });
  if (onlineCountEl) onlineCountEl.style.display = 'none';
}

function hideInstallButtons() {
  [installBtn, installBtnHeader].forEach(btn => { if (btn) btn.style.display = 'none'; });
  if (onlineCountEl) onlineCountEl.style.display = '';
}

if (isInstalled) {
  hideInstallButtons();
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  showInstallButtons();
});

window.addEventListener('appinstalled', () => {
  hideInstallButtons();
});

function triggerInstall() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  deferredInstallPrompt.userChoice.then(({ outcome }) => {
    deferredInstallPrompt = null;
    hideInstallButtons();
  });
}

installBtn?.addEventListener('click', triggerInstall);
installBtnHeader?.addEventListener('click', triggerInstall);

// Register service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ── Self-view draggable ────────────────────────────────────────────────────

(function initSelfViewDrag() {
  if (!selfViewContainer) return;
  let dragging = false, startX = 0, startY = 0, initX = 0, initY = 0;

  selfViewContainer.style.position = 'fixed';
  selfViewContainer.style.left = '16px';
  selfViewContainer.style.bottom = '72px';

  selfViewContainer.addEventListener('pointerdown', (e) => {
    // Don't start drag from toggle button
    if (e.target === selfViewToggle || selfViewToggle?.contains(e.target)) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    initX = parseInt(selfViewContainer.style.left) || 16;
    initY = parseInt(selfViewContainer.style.bottom) || 72;
    selfViewContainer.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = startY - e.clientY;
    const maxX = window.innerWidth - selfViewContainer.offsetWidth - 8;
    const maxY = window.innerHeight - selfViewContainer.offsetHeight - 60;
    selfViewContainer.style.left = Math.min(maxX, Math.max(8, initX + dx)) + 'px';
    selfViewContainer.style.right = 'auto';
    selfViewContainer.style.bottom = Math.min(maxY, Math.max(56, initY + dy)) + 'px';
    selfViewContainer.style.top = 'auto';
  });

  window.addEventListener('pointerup', () => { dragging = false; });
})();

// ── Self-view hide/show toggle ─────────────────────────────────────────────

let selfViewHidden = false;

selfViewToggle?.addEventListener('click', (e) => {
  e.stopPropagation();
  selfViewHidden = !selfViewHidden;
  updateSelfViewState();
});

function updateSelfViewState() {
  if (!selfView || !selfViewContainer || !selfViewToggle) return;
  if (selfViewHidden) {
    selfView.style.display = 'none';
    selfViewContainer.style.width = '28px';
    selfViewContainer.style.height = '28px';
    selfViewContainer.style.borderRadius = '50%';
    selfViewContainer.style.overflow = 'hidden';
    selfViewContainer.style.background = 'rgba(0,0,0,0.5)';
    selfViewContainer.style.backdropFilter = 'blur(4px)';
    selfViewContainer.style.boxShadow = '0 2px 8px rgba(0,0,0,0.4)';
    selfViewToggle.textContent = '👁';
    selfViewToggle.title = 'Show self view';
    selfViewToggle.style.top = '0';
    selfViewToggle.style.right = '0';
    if (selfViewDragHandle) selfViewDragHandle.style.display = 'block';
  } else {
    selfView.style.display = '';
    selfViewContainer.style.width = '';
    selfViewContainer.style.height = '';
    selfViewContainer.style.borderRadius = '';
    selfViewContainer.style.overflow = '';
    selfViewContainer.style.background = '';
    selfViewContainer.style.backdropFilter = '';
    selfViewContainer.style.boxShadow = '';
    selfViewToggle.textContent = '✕';
    selfViewToggle.title = 'Hide self view';
    selfViewToggle.style.top = '-8px';
    selfViewToggle.style.right = '-8px';
    if (selfViewDragHandle) selfViewDragHandle.style.display = 'none';
  }
}

// Push self-view inside fullscreen video modals
let wasFullscreen = false;
let fsHostModal = null;
document.addEventListener('fullscreenchange', () => {
  const isFs = !!document.fullscreenElement;
  if (!selfViewContainer) return;

  if (isFs && document.fullscreenElement.classList.contains('video-modal')) {
    wasFullscreen = true;
    fsHostModal = document.fullscreenElement;
    fsHostModal.appendChild(selfViewContainer);
    selfViewContainer.style.zIndex = '10';
    selfViewContainer.style.position = 'absolute';
    selfViewContainer.style.bottom = '16px';
    selfViewContainer.style.left = '16px';
  } else if (wasFullscreen) {
    wasFullscreen = false;
    document.body.appendChild(selfViewContainer);
    selfViewContainer.style.zIndex = '180';
    selfViewContainer.style.position = 'fixed';
    fsHostModal = null;
  }

  // Safety: if self-view is orphaned inside a removed modal, move it back
  if (!isFs && !document.body.contains(selfViewContainer)) {
    document.body.appendChild(selfViewContainer);
    selfViewContainer.style.zIndex = '180';
    selfViewContainer.style.position = 'fixed';
  }
});
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
const settingsModal    = document.getElementById('settings-modal');
const settingsBtnLanding = document.getElementById('settings-btn-landing');
const confirmModal     = document.getElementById('confirm-modal');
const confirmMsg       = document.getElementById('confirm-modal-message');
const confirmCancel    = document.getElementById('confirm-modal-cancel');
const confirmOk        = document.getElementById('confirm-modal-ok');

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
  if (!serverInput.value) {
    const recent = loadRecentServers();
    if (recent.length > 0) serverInput.value = recent[0].name;
  }
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
      // Don't cleanup immediately — net.js is attempting auto-reconnect.
      // If reconnect fails, we'll get __reconnect_failed.
      stopKeepAlive();
      break;

    case '__reconnect_failed':
      // All reconnect attempts exhausted — full cleanup
      stopKeepAlive();
      cleanupAll();
      showAlert('Connection lost. Please rejoin the server.');
      break;

    case 'server-state':
      userId = msg.yourUserId;
      isCreator = (msg.creator === userId);
      serverState = msg;
      saveUsername(username);
      saveRecentServer(serverName, msg.hasPassword);
      
      // Save reconnect info for auto-reconnect on mobile
      if (msg.reconnectToken) {
        saveReconnectInfo(serverName, userId, username, serverPassword, msg.reconnectToken);
      }
      
      if (msg.reconnected) {
        // Reconnected — restore channel state without full re-init
        console.log('[app] Session restored via reconnect');
        renderChannels(msg.channels);
        updateOnlineCount(msg.users);
        if (isCreator) showCreatorTools();
        serverPassword = '';
        startKeepAlive();
        
        // If we were in a channel, restore it
        const ourUser = serverState.users[userId];
        if (ourUser?.channelName) {
          currentChannel = ourUser.channelName;
          updatePageTitle();
          setChannelTitle(serverState?.channels[ourUser.channelName]?.name || ourUser.channelName);
          showChat();
          addChatMessage(null, null, '📶 Reconnected to ' + (serverState?.channels[ourUser.channelName]?.name || ourUser.channelName), Date.now(), true);
          renderChannelUsers(ourUser.channelName);
          // Re-establish WebRTC with peers
          const chUsers = serverState.channels[ourUser.channelName]?.users || {};
          Object.keys(chUsers).forEach(peerId => {
            if (peerId !== userId && !peerConnections.has(peerId)) {
              initiateWebRTC(peerId);
            }
          });
          // Re-request mic
          ensureLocalStream();
          updateMicControls();
        }
        break;
      }
      
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
        serverState.users[msg.userId] = { userId: msg.userId, username: msg.username, channelName: msg.channelName, avatar: msg.avatar || null };
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
          if (msg.avatar !== undefined) user.avatar = msg.avatar;
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

    case 'avatar-changed':
      if (serverState && serverState.users[msg.userId]) {
        serverState.users[msg.userId].avatar = msg.avatar || null;
        if (currentChannel) renderChannelUsers(currentChannel);
      }
      break;

    case 'video-state-changed':
      if (currentChannel) renderChannelUsers(currentChannel);
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
      // If reconnect failed, fall back to a fresh join
      if (msg.message && (msg.message.includes('reconnect') || msg.message.includes('expired'))) {
        console.log('[app] Reconnect failed (' + msg.message + '), falling back to fresh join');
        stopKeepAlive();
        clearReconnectInfo();
        // Clean up old WebRTC / audio state (new join gets fresh userId)
        cleanupWebRTC();
        currentChannel = null;
        serverState = null;
        if (ws) { try { ws.close(); } catch (e) { /* ignore */ } }
        // Retry with a regular join after a short delay
        setTimeout(() => {
          connectWebSocket(serverName, username, serverPassword, handleSignaling);
        }, 600);
        break;
      }
      showAlert('Error: ' + msg.message);
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

async function leaveServer() {
  const ok = await showConfirm('Leave this server?');
  if (!ok) return;
  // Notify server we're leaving intentionally — no grace period
  sendWs({ type: 'disconnect' });
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

  // Self-view: show when sharing camera, hide otherwise
  if (sharing && !isScreen && selfView && selfViewContainer) {
    selfView.srcObject = typeof localVideoStream !== 'undefined' ? localVideoStream : null;
    selfViewContainer.style.display = '';
    // Match self-view size ratio to camera's native ratio
    selfView.addEventListener('loadedmetadata', () => {
      if (!selfView.videoWidth || !selfView.videoHeight) return;
      const ratio = selfView.videoWidth / selfView.videoHeight;
      const baseH = 120;
      const h = Math.round(baseH);
      const w = Math.round(h * ratio);
      selfView.style.width = w + 'px';
      selfView.style.height = h + 'px';
    }, { once: true });
  } else if (selfViewContainer) {
    selfView.srcObject = null;
    selfViewContainer.style.display = 'none';
  }
}

// ── Confirm / Alert modal (replaces native dialogs) ────────────────────────

function showAlert(message) {
  return new Promise((resolve) => {
    confirmMsg.textContent = message;
    confirmCancel.style.display = 'none';
    confirmOk.textContent = 'OK';
    confirmOk.onclick = () => { confirmModal.style.display = 'none'; resolve(); };
    confirmModal.style.display = 'flex';
  });
}

function showConfirm(message) {
  return new Promise((resolve) => {
    confirmMsg.textContent = message;
    confirmCancel.style.display = '';
    confirmOk.textContent = 'OK';
    confirmCancel.onclick = () => { confirmModal.style.display = 'none'; resolve(false); };
    confirmOk.onclick = () => { confirmModal.style.display = 'none'; resolve(true); };
    confirmModal.style.display = 'flex';
  });
}

confirmModal?.addEventListener('click', (e) => {
  if (e.target === confirmModal) confirmModal.style.display = 'none';
});

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
    console.log('[app] Page became visible — recovering mobile session');
    await requestWakeLock();
    
    // Resume audio if suspended (common on mobile after screen lock)
    try {
      await ensureAudioRunning();
      recoverAudioOnInteraction();
    } catch (e) { /* ignore */ }
    
    // Check WebSocket health
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      console.log('[app] WebSocket dead — triggering reconnect');
      // net.js auto-reconnect will handle this if we let the close handler fire
      // But if it wasn't triggered, try reconnecting now
      if (typeof attemptReconnect === 'function' && typeof hasReconnectInfo === 'function' && hasReconnectInfo()) {
        attemptReconnect();
      }
    } else if (ws.readyState === WebSocket.OPEN) {
      // Send ping to keep alive and check connection
      ws.send(JSON.stringify({ type: 'ping' }));
      
      // Re-request mic if we were in a channel (may have been released)
      if (currentChannel && !hasLocalStream()) {
        await ensureLocalStream();
        updateMicControls();
      }
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

setPwBtnHeader?.addEventListener('click', showSetPwModal);
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

// ── Share Modal ─────────────────────────────────────────────────────────

function getShareUrl() {
  return `${window.location.origin}/server/${encodeURIComponent(serverName)}`;
}

let scanStream = null;
let scanRaf = null;

shareBtn?.addEventListener('click', () => {
  openShareModal();
});

function openShareModal() {
  const url = getShareUrl();
  new QRious({ element: qrCodeCanvas, value: url, size: 250 });
  if (shareUrlInput) shareUrlInput.value = url;
  // Show native share button only when Web Share API is available (mobile)
  if (shareNativeBtn) {
    shareNativeBtn.style.display = navigator.share ? '' : 'none';
  }
  shareModal.style.display = 'flex';
  // Reset to share tab
  switchShareTab('share');
}

function closeShareModal() {
  shareModal.style.display = 'none';
  stopScan();
}

shareModalClose?.addEventListener('click', closeShareModal);
shareModal?.addEventListener('click', (e) => {
  if (e.target === shareModal) closeShareModal();
});

// Copy link from modal
// Native share (mobile)
shareNativeBtn?.addEventListener('click', async () => {
  const url = shareUrlInput.value;
  try {
    await navigator.share({ url });
  } catch (_) { /* user cancelled or not supported */ }
});

shareCopyBtn?.addEventListener('click', () => {
  const url = shareUrlInput.value;
  navigator.clipboard.writeText(url).then(() => {
    shareCopyBtn.textContent = '✓ Copied';
    setTimeout(() => { shareCopyBtn.textContent = '📋 Copy'; }, 2000);
  }).catch(() => {
    shareUrlInput.select();
    document.execCommand('copy');
    shareCopyBtn.textContent = '✓ Copied';
    setTimeout(() => { shareCopyBtn.textContent = '📋 Copy'; }, 2000);
  });
});

// Tab switching
const shareTabs = document.querySelectorAll('.share-tab');
const sharePanels = document.querySelectorAll('.share-tab-panel');

shareTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const name = tab.dataset.tab;
    switchShareTab(name);
  });
});

function switchShareTab(name) {
  shareTabs.forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  sharePanels.forEach(p => p.classList.toggle('active', p.id === name + '-tab-panel'));
  if (name === 'scan') {
    startScan();
  } else {
    stopScan();
  }
}

// ── QR Scanner ──────────────────────────────────────────────────────────

async function startScan() {
  if (scanStream) return;
  scanStatus.textContent = 'Starting camera…';
  scanStatus.style.display = '';
  scanResult.style.display = 'none';
  scanResult.className = 'scan-result';
  scanOpenBtn.style.display = 'none';
  const warning = document.querySelector('.scan-warning');
  if (warning) {
    warning.textContent = 'Point your camera at a QR code';
    warning.className = 'scan-warning';
  }

  try {
    scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }
    });
    scanVideo.srcObject = scanStream;
    await scanVideo.play();
    scanStatus.textContent = 'Point your camera at a QR code';

    const canvas = scanCanvas;
    const ctx = canvas.getContext('2d');
    let lastResult = '';

    function tick() {
      if (!scanStream) return;
      if (scanVideo.readyState >= scanVideo.HAVE_CURRENT_DATA) {
        canvas.width = scanVideo.videoWidth;
        canvas.height = scanVideo.videoHeight;
        ctx.drawImage(scanVideo, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height);
        if (code && code.data !== lastResult) {
          lastResult = code.data;
          onScanResult(code.data);
        }
      }
      scanRaf = requestAnimationFrame(tick);
    }
    tick();
  } catch (e) {
    scanStatus.textContent = 'Camera not available: ' + (e.message || 'denied');
  }
}

function onScanResult(data) {
  scanStatus.style.display = 'none';
  scanResult.textContent = data;
  scanResult.style.display = '';
  scanResult.title = data;

  const warning = document.querySelector('.scan-warning');

  try {
    const url = new URL(data);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      const isSameOrigin = url.origin === window.location.origin;
      const isServerLink = /^\/server\/[a-z0-9-]+$/.test(url.pathname);

      if (isSameOrigin && isServerLink) {
        // Same server link — safe
        scanResult.className = 'scan-result safe';
        scanOpenBtn.textContent = '🔗 Open';
        scanOpenBtn.style.display = '';
        scanOpenBtn.className = 'btn-primary btn-sm';
        if (warning) {
          warning.textContent = 'Safe - a channel link';
          warning.className = 'scan-warning safe';
        }
      } else {
        // External domain — warning
        scanResult.className = 'scan-result external';
        scanOpenBtn.textContent = '🔗 Open Link';
        scanOpenBtn.style.display = '';
        scanOpenBtn.className = 'btn-primary btn-sm btn-warning';
        if (warning) {
          warning.textContent = '⚠️ External link — only open if you trust the source';
          warning.className = 'scan-warning external';
        }
      }

      scanOpenBtn.onclick = () => {
        window.open(data, '_blank', 'noopener');
      };
    } else {
      scanOpenBtn.style.display = 'none';
    }
  } catch (_) {
    scanOpenBtn.style.display = 'none';
  }

  stopScan();
}

function stopScan() {
  if (scanRaf) { cancelAnimationFrame(scanRaf); scanRaf = null; }
  if (scanStream) {
    scanStream.getTracks().forEach(t => t.stop());
    scanStream = null;
    scanVideo.srcObject = null;
  }
}

// Settings cog — landing page + sidebar
document.getElementById('settings-btn-landing')?.addEventListener('click', (e) => {
  e.preventDefault();
  if (typeof openSettings === 'function') openSettings();
});
document.getElementById('settings-btn-sidebar')?.addEventListener('click', () => {
  if (typeof openSettings === 'function') openSettings();
});
document.getElementById('settings-modal-close')?.addEventListener('click', () => {
  if (typeof closeSettings === 'function') closeSettings();
});
document.getElementById('settings-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'settings-modal' && typeof closeSettings === 'function') closeSettings();
});

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
    if (shareModal && shareModal.style.display === 'flex') { closeShareModal(); return; }
    if (settingsModal && settingsModal.style.display === 'flex' && !document.fullscreenElement) {
      closeSettings();
      return;
    }
    if (recentModal.style.display === 'flex') hideRecentModal();
    if (passwordModal.style.display === 'flex') hidePasswordModal();
    if (renameModal.style.display === 'flex') hideRenameModal();
    if (setPwModal.style.display === 'flex') hideSetPwModal();
  }
});

// ── Page lifecycle ───────────────────────────────────────────────────────────

// On tab close / navigation: full cleanup
window.addEventListener('beforeunload', () => {
  // Try to notify server of intentional disconnect
  sendWs({ type: 'disconnect' });
  cleanupAll();
});

// On mobile page suspension (iOS Safari freezes pages): save reconnect state
// but don't close WebSocket (browser may keep it alive briefly)
window.addEventListener('pagehide', (e) => {
  // If this is a persistent pagehide (not just bfcache), we'll reconnect on return
  if (e.persisted) {
    // Page is going into bfcache — keep reconnect info but don't cleanup
    console.log('[app] Page entering bfcache — saving reconnect state');
  } else {
    // Page is being destroyed — save reconnect info then cleanup
    console.log('[app] Page being destroyed — saving reconnect state');
  }
});

// On pageshow (returning from bfcache or mobile suspension)
window.addEventListener('pageshow', async (e) => {
  if (e.persisted) {
    console.log('[app] Page restored from bfcache — recovering');
    // Re-request wake lock and check connection
    await requestWakeLock();
    try { await ensureAudioRunning(); } catch (ex) { /* ignore */ }
  }
});
