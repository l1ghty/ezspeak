// ── App entry point ─────────────────────────────────────────────────────────
// Loaded last.  Wires modules together: routing, signaling dispatch,
// global state, event bindings, and cleanup.
// All audio uses WebRTC full mesh — no relay, no mixer. Simple.

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
const sidebarToggleBtn  = document.getElementById('sidebar-toggle-btn');
const sidebarCloseBtn   = document.getElementById('sidebar-close-btn');
const sidebarOverlay    = document.getElementById('sidebar-overlay');
const sidebarEl         = document.getElementById('sidebar');

// ── Global state ────────────────────────────────────────────────────────────
let userId             = null;
let username           = '';
let serverName         = '';
let serverPassword     = '';
let isCreator          = false;
let currentChannel     = null;
let serverState        = null;

// ── Callback wiring ─────────────────────────────────────────────────────────
onConnectionStatusChange(setConnectionStatus);
onSpeakingChange(() => { if (currentChannel) renderChannelUsers(currentChannel); });

// ── URL routing ─────────────────────────────────────────────────────────────
const pathMatch = window.location.pathname.match(/^\/server\/(.+)/);
if (pathMatch) {
  serverName = decodeURIComponent(pathMatch[1]);
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
      // Auto-join first channel
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
      setChannelTitle(serverState?.channels[msg.channelName]?.name || msg.channelName);
      showChat(); clearChat();
      addChatMessage(null, null, `You joined ${serverState?.channels[msg.channelName]?.name || msg.channelName}`, Date.now(), true);
      renderChannelUsers(msg.channelName);
      // Don't initiate — existing peers will initiate via peer-joined-channel.
      // We handle incoming offers.
      break;

    case 'peer-joined-channel':
      if (currentChannel === msg.channelName) {
        console.log('[app] peer-joined ' + msg.username + ' totalUsers=' + msg.totalUsers);
        addChatMessage(null, null, `${msg.username} joined the channel`, Date.now(), true);
        playBeep('join');
        // Store peer's mute/deafen state
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
      if (currentChannel === msg.channelName) {
        const peerName = serverState?.users[msg.userId]?.username || msg.username;
        addChatMessage(null, null, `${peerName} left the channel`, Date.now(), true);
        playBeep('leave');
        renderChannelUsers(currentChannel);
      }
      break;

    case 'left-channel':
      currentChannel = null;
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
    playBeep('switch');
  }
  closeSidebar();
  await ensureLocalStream();
  sendWs({ type: 'join-channel', channelName });
  // Highlight in sidebar
  document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
  const items = document.querySelectorAll('.channel-item');
  const names = Object.keys(serverState?.channels || {});
  const idx = names.indexOf(channelName);
  if (idx >= 0 && items[idx]) items[idx].classList.add('active');
}

function leaveServer() {
  cleanupAll();
  window.location.href = '/';
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

function cleanupAll() {
  releaseWakeLock();
  cleanupWebRTC();
  cleanupAudio();
  currentChannel = null;
  serverState = null;
  closeWs();
}

// ── Wake Lock (keep screen on during calls) ─────────────────────────────────

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
  const muted = toggleMute();
  muteBtn.classList.toggle('active', muted);
  muteBtn.querySelector('.label').textContent = muted ? 'Muted' : 'Mute';
  muteBtn.querySelector('.icon').textContent = muted ? '🤐' : '🎙️';
});

deafenBtn.addEventListener('click', () => {
  const deafened = toggleDeafen();
  deafenBtn.classList.toggle('active', deafened);
  deafenBtn.querySelector('.label').textContent = deafened ? 'Deafened' : 'Deafen';
  deafenBtn.querySelector('.icon').textContent = deafened ? '🔇' : '🔊';
});

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  sendChatMessage();
});

leaveServerBtn.addEventListener('click', leaveServer);

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
    if (recentModal.style.display === 'flex') hideRecentModal();
    if (passwordModal.style.display === 'flex') hidePasswordModal();
    if (renameModal.style.display === 'flex') hideRenameModal();
    if (setPwModal.style.display === 'flex') hideSetPwModal();
  }
});

window.addEventListener('beforeunload', () => {
  cleanupAll();
});
