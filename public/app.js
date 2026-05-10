// ═══════════════════════════════════════════════════════════════════════════════
// e z s p e a k  —  WebRTC mesh voice chat client
// ═══════════════════════════════════════════════════════════════════════════════

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// ── localStorage keys ────────────────────────────────────────────────────────
const LS_USERNAME = 'ezspeak_username';
const LS_RECENT   = 'ezspeak_recent_servers';
const SS_PASSWORD = 'ezspeak_pw';

// ── Browser detection & default username ─────────────────────────────────────
function detectBrowser() {
  const ua = navigator.userAgent;
  if (ua.includes('Firefox')) return 'firefox';
  if (ua.includes('Edg')) return 'edge';
  if (ua.includes('Chrome')) return 'chrome';
  if (ua.includes('Safari')) return 'safari';
  return 'web';
}

function generateDefaultUsername() {
  const num = Math.floor(1000 + Math.random() * 9000);
  return `ezhuman-${detectBrowser()}-${num}`;
}

function loadSavedUsername() {
  return localStorage.getItem(LS_USERNAME) || generateDefaultUsername();
}

function saveUsername(name) {
  if (name && name.trim()) localStorage.setItem(LS_USERNAME, name.trim());
}

// ── Recent servers ───────────────────────────────────────────────────────────
function loadRecentServers() {
  try { return JSON.parse(localStorage.getItem(LS_RECENT) || '[]'); } catch { return []; }
}

function saveRecentServer(name, hasPassword) {
  const servers = loadRecentServers().filter(s => s.name !== name);
  servers.unshift({ name, hasPassword, timestamp: Date.now() });
  localStorage.setItem(LS_RECENT, JSON.stringify(servers.slice(0, 10)));
}

function updateRecentServerPassword(name, hasPassword) {
  const servers = loadRecentServers();
  const s = servers.find(s => s.name === name);
  if (s) { s.hasPassword = hasPassword; localStorage.setItem(LS_RECENT, JSON.stringify(servers)); }
}

function removeRecentServer(name) {
  localStorage.setItem(LS_RECENT, JSON.stringify(loadRecentServers().filter(s => s.name !== name)));
}

// ── DOM refs ─────────────────────────────────────────────────────────────────
const landingPage     = document.getElementById('landing-page');
const serverPage      = document.getElementById('server-page');
const joinForm        = document.getElementById('join-form');
const usernameInput   = document.getElementById('username-input');
const serverInput     = document.getElementById('server-input');
const pwLanding       = document.getElementById('password-input-landing');
const serverNameDisplay = document.getElementById('server-name-display');
const channelList     = document.getElementById('channel-list');
const addChannelSection = document.getElementById('add-channel-section');
const addChannelForm  = document.getElementById('add-channel-form');
const newChannelInput = document.getElementById('new-channel-input');
const currentChannelTitle = document.getElementById('current-channel-title');
const channelUserCount = document.getElementById('channel-user-count');
const userList        = document.getElementById('user-list');
const onlineCount     = document.getElementById('online-count');
const muteBtn         = document.getElementById('mute-btn');
const deafenBtn       = document.getElementById('deafen-btn');
const renameBtn       = document.getElementById('rename-btn');
const setPwBtn        = document.getElementById('set-pw-btn');
const leaveServerBtn  = document.getElementById('leave-server-btn');
const statusDot       = document.getElementById('status-dot');
const statusText      = document.getElementById('status-text');

// Recent servers
const recentModal     = document.getElementById('recent-modal');
const recentList      = document.getElementById('recent-list');
const recentModalClose = document.getElementById('recent-modal-close');
const recentBtnLanding = document.getElementById('recent-btn-landing');
const recentBtnSidebar = document.getElementById('recent-btn-sidebar');

// Password join
const passwordModal   = document.getElementById('password-modal');
const passwordForm    = document.getElementById('password-form');
const pwModalInput    = document.getElementById('password-modal-input');
const pwError         = document.getElementById('password-error');

// Rename
const renameModal     = document.getElementById('rename-modal');
const renameForm      = document.getElementById('rename-form');
const renameInput     = document.getElementById('rename-input');

// Set password
const setPwModal      = document.getElementById('set-pw-modal');
const setPwForm       = document.getElementById('set-pw-form');
const setPwInput      = document.getElementById('set-pw-input');

// Chat
const chatPanel       = document.getElementById('chat-panel');
const chatMessages    = document.getElementById('chat-messages');
const chatForm        = document.getElementById('chat-form');
const chatInput       = document.getElementById('chat-input');

// ── State ────────────────────────────────────────────────────────────────────
let ws = null;
let userId = null;
let username = '';
let serverName = '';
let serverPassword = '';
let isCreator = false;
let currentChannel = null;
let serverState = null;
let localStream = null;
let isMuted = false;
let isDeafened = false;

// WebRTC
const peerConnections = new Map();
const remoteAudios = new Map();
const pendingCandidates = new Map();

// Speaking detection
let audioContext = null;
let hasSwitchedChannel = false;  // tracks if user manually switched (for switch beep)
const speakingPeers = new Map();   // peerId -> boolean
const analysers = new Map();       // peerId -> { source, analyser, interval }
let localSpeaking = false;

function getAudioContext() {
  if (!audioContext) audioContext = new AudioContext();
  if (audioContext.state === 'suspended') audioContext.resume();
  return audioContext;
}

// ── Sound effects ────────────────────────────────────────────────────────────
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
    const speaking = avg > 8;
    if (isLocal) {
      if (localSpeaking !== speaking) { localSpeaking = speaking; renderChannelUsers(currentChannel); }
    } else {
      if (speakingPeers.get(peerId) !== speaking) {
        speakingPeers.set(peerId, speaking);
        renderChannelUsers(currentChannel);
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

// ── URL routing ──────────────────────────────────────────────────────────────
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
  connectWebSocket();
}

// ── Recent Servers Modal ─────────────────────────────────────────────────────
function showRecentModal() { renderRecentServers(); recentModal.style.display = 'flex'; }
function hideRecentModal() { recentModal.style.display = 'none'; }

function renderRecentServers() {
  const servers = loadRecentServers();
  if (servers.length === 0) {
    recentList.innerHTML = '<p class="placeholder">No recent servers yet. Join one to see it here!</p>';
    return;
  }
  recentList.innerHTML = servers.map(s => `
    <div class="recent-item" data-server="${escapeHtml(s.name)}">
      <span class="recent-icon">🔊</span>
      <span class="recent-name">${escapeHtml(s.name)}</span>
      ${s.hasPassword ? '<span class="recent-lock">🔒</span>' : ''}
      <span class="recent-time">${formatTimeAgo(s.timestamp)}</span>
      <button class="recent-delete" data-server="${escapeHtml(s.name)}" title="Remove">✕</button>
    </div>
  `).join('');

  recentList.querySelectorAll('.recent-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('recent-delete')) return;
      hideRecentModal();
      navigateToServer(item.dataset.server);
    });
  });
  recentList.querySelectorAll('.recent-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeRecentServer(btn.dataset.server);
      renderRecentServers();
    });
  });
}

function navigateToServer(name) {
  saveUsername(usernameInput.value || username);
  window.location.href = `/server/${encodeURIComponent(name)}`;
}

// ── Rename Modal ─────────────────────────────────────────────────────────────
function showRenameModal() {
  renameInput.value = username;
  renameModal.style.display = 'flex';
  renameInput.focus();
}
function hideRenameModal() { renameModal.style.display = 'none'; }

// ── Set Password Modal ───────────────────────────────────────────────────────
function showSetPwModal() { setPwInput.value = ''; setPwModal.style.display = 'flex'; setPwInput.focus(); }
function hideSetPwModal() { setPwModal.style.display = 'none'; }

// ── Password Modal ───────────────────────────────────────────────────────────
function showPasswordModal() {
  pwModalInput.value = ''; pwError.style.display = 'none';
  passwordModal.style.display = 'flex'; pwModalInput.focus();
}
function hidePasswordModal() { passwordModal.style.display = 'none'; }

// ── WebSocket ────────────────────────────────────────────────────────────────
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  setConnectionStatus('connecting', 'Connecting...');
  if (ws) { try { ws.close(); } catch (e) { /* ignore */ } }

  ws = new WebSocket(`${protocol}//${window.location.host}`);
  ws.onopen = () => {
    setConnectionStatus('connected', 'Connected');
    const msg = { type: 'join-server', serverName, username };
    if (serverPassword) msg.password = serverPassword;
    ws.send(JSON.stringify(msg));
  };
  ws.onmessage = (e) => handleSignaling(JSON.parse(e.data));
  ws.onclose = () => { setConnectionStatus('disconnected', 'Disconnected'); cleanupAll(); };
  ws.onerror = () => { setConnectionStatus('disconnected', 'Error'); };
}

function sendWs(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ── Signaling handler ────────────────────────────────────────────────────────
function handleSignaling(msg) {
  switch (msg.type) {

    case 'server-state':
      userId = msg.yourUserId;
      isCreator = (msg.creator === userId);
      serverState = msg;
      saveUsername(username);
      saveRecentServer(serverName, msg.hasPassword);
      renderChannels(msg.channels);
      renderUsers(msg.users);
      updateOnlineCount(msg.users);
      if (isCreator) {
        addChannelSection.style.display = 'block';
        setPwBtn.style.display = '';
      }
      serverPassword = '';
      // Auto-join first channel (lobby)
      const firstChannel = Object.keys(msg.channels)[0];
      if (firstChannel && !currentChannel) joinChannel(firstChannel);
      break;

    case 'password-required':
      setConnectionStatus('disconnected', 'Password required');
      if (ws) { try { ws.close(); } catch (e) { /* ignore */ } }
      showPasswordModal();
      break;

    case 'user-joined-server':
      if (serverState) {
        serverState.users[msg.userId] = { userId: msg.userId, username: msg.username, channelName: msg.channelName };
        renderUsers(serverState.users);
        updateOnlineCount(serverState.users);
      }
      break;

    case 'user-left-server':
      if (serverState) {
        delete serverState.users[msg.userId];
        for (const ch of Object.values(serverState.channels)) delete ch.users[msg.userId];
        closePeerConnection(msg.userId);
        renderChannels(serverState.channels);
        renderUsers(serverState.users);
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
        renderChannelUsers(currentChannel);
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
        renderUsers(serverState.users);
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
      currentChannel = msg.channelName;
      currentChannelTitle.textContent = serverState?.channels[msg.channelName]?.name || msg.channelName;
      chatPanel.style.display = '';
      chatMessages.innerHTML = '';
      addChatMessage(null, null, `You joined ${serverState?.channels[msg.channelName]?.name || msg.channelName}`, Date.now(), true);
      renderChannelUsers(msg.channelName);
      break;

    case 'chat-message':
      addChatMessage(msg.userId, msg.username, msg.message, msg.timestamp);
      break;

    case 'left-channel':
      currentChannel = null;
      currentChannelTitle.textContent = 'Not in a channel';
      channelUserCount.textContent = '';
      userList.innerHTML = '<p class="placeholder">Select a channel from the sidebar to start talking</p>';
      chatPanel.style.display = 'none';
      chatMessages.innerHTML = '';
      closeAllPeerConnections();
      break;

    case 'peer-joined-channel':
      if (currentChannel === msg.channelName) {
        initiateWebRTC(msg.userId);
        addChatMessage(null, null, `${msg.username} joined the channel`, Date.now(), true);
        playBeep('join');
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

    case 'webrtc-offer':   handleOffer(msg.fromId, msg.offer); break;
    case 'webrtc-answer':  handleAnswer(msg.fromId, msg.answer); break;
    case 'webrtc-ice-candidate': handleIceCandidate(msg.fromId, msg.candidate); break;

    case 'error':
      alert('Error: ' + msg.message);
      break;

    default:
      console.log('Unhandled message:', msg.type, msg);
  }
}

// ── WebRTC ───────────────────────────────────────────────────────────────────
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

function applyMuteState() {
  if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted && !isDeafened; });
}

function applyDeafenState() {
  remoteAudios.forEach(a => { a.muted = isDeafened; });
}

function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.onicecandidate = (e) => { if (e.candidate) sendWs({ type: 'webrtc-ice-candidate', targetId: peerId, candidate: e.candidate }); };
  pc.ontrack = (e) => { if (e.streams && e.streams[0]) addRemoteStream(peerId, e.streams[0]); };
  pc.oniceconnectionstatechange = () => {
    if (['disconnected','failed','closed'].includes(pc.iceConnectionState)) closePeerConnection(peerId);
  };
  peerConnections.set(peerId, pc);
  return pc;
}

function addRemoteStream(peerId, stream) {
  if (remoteAudios.has(peerId)) {
    remoteAudios.get(peerId).srcObject = null;
    remoteAudios.get(peerId).remove();
  }
  const audio = new Audio();
  audio.srcObject = stream;
  audio.autoplay = true;
  audio.muted = isDeafened;
  audio.play().catch(e => console.warn('Audio play failed:', e));
  remoteAudios.set(peerId, audio);
  startSpeakingDetection(peerId, stream, false);
  renderChannelUsers(currentChannel);
}

async function initiateWebRTC(peerId) {
  await ensureLocalStream();
  const pc = createPeerConnection(peerId);
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendWs({ type: 'webrtc-offer', targetId: peerId, offer });
  } catch (err) { console.error('Error creating offer:', err); closePeerConnection(peerId); }
}

async function handleOffer(fromId, offer) {
  await ensureLocalStream();
  const pc = createPeerConnection(fromId);
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
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

function closePeerConnection(peerId) {
  const pc = peerConnections.get(peerId);
  if (pc) { pc.close(); peerConnections.delete(peerId); }
  if (remoteAudios.has(peerId)) {
    remoteAudios.get(peerId).srcObject = null;
    remoteAudios.get(peerId).remove();
    remoteAudios.delete(peerId);
  }
  stopSpeakingDetection(peerId);
  pendingCandidates.delete(peerId);
  renderChannelUsers(currentChannel);
}

function closeAllPeerConnections() {
  for (const peerId of peerConnections.keys()) closePeerConnection(peerId);
}

function cleanupAll() {
  closeAllPeerConnections();
  stopSpeakingDetection('__self__');
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  currentChannel = null;
  serverState = null;
  peerConnections.clear();
  remoteAudios.forEach(a => { a.srcObject = null; a.remove(); });
  remoteAudios.clear();
  pendingCandidates.clear();
  analysers.forEach(e => { clearInterval(e.interval); try { e.source.disconnect(); } catch (_) {} });
  analysers.clear();
  speakingPeers.clear();
  localSpeaking = false;
}

// ── UI Rendering ─────────────────────────────────────────────────────────────
function renderChannels(channels) {
  channelList.innerHTML = '';
  for (const [key, ch] of Object.entries(channels)) {
    const userCount = Object.keys(ch.users).length;
    const div = document.createElement('div');
    div.className = 'channel-item' + (currentChannel === key ? ' active' : '');
    div.innerHTML = `
      <span class="channel-icon">${userCount > 0 ? '🔊' : '🔇'}</span>
      <span class="channel-name">${escapeHtml(ch.name)}</span>
      <span class="channel-count">${userCount}</span>
    `;
    div.addEventListener('click', () => joinChannel(key));
    channelList.appendChild(div);
  }
}

function renderUsers(users) { /* no-op */ }

function renderChannelUsers(channelName) {
  if (!channelName || !serverState || !serverState.channels[channelName]) {
    userList.innerHTML = '<p class="placeholder">Select a channel from the sidebar to start talking</p>';
    channelUserCount.textContent = '';
    return;
  }
  const channel = serverState.channels[channelName];
  const users = Object.values(channel.users);
  channelUserCount.textContent = `${users.length} user${users.length !== 1 ? 's' : ''}`;
  currentChannelTitle.textContent = channel.name;

  if (users.length === 0) {
    userList.innerHTML = '<p class="placeholder">No one here yet. Invite friends!</p>';
    return;
  }

  userList.innerHTML = users.map(u => {
    const isSelf = u.userId === userId;
    const isConnected = isSelf || peerConnections.has(u.userId);
    const speaking = isSelf ? localSpeaking : speakingPeers.get(u.userId);
    const initial = (u.username || '?')[0].toUpperCase();
    return `
      <div class="user-item">
        <div class="user-avatar ${isSelf ? 'self' : ''} ${speaking ? 'speaking' : ''}">${initial}</div>
        <span class="user-name">${escapeHtml(u.username)} ${isSelf ? '(you)' : ''}</span>
        ${isSelf ? '<span class="user-badge">You</span>' : ''}
        <div class="user-indicator ${isConnected ? 'connected' : 'disconnected'}"></div>
      </div>
    `;
  }).join('');
}

function updateOnlineCount(users) { onlineCount.textContent = `${Object.keys(users).length} online`; }
function setConnectionStatus(status, text) { statusDot.className = 'dot ' + status; statusText.textContent = text; }

// ── Actions ──────────────────────────────────────────────────────────────────
async function joinChannel(channelName) {
  if (currentChannel === channelName) return;
  if (currentChannel) {
    sendWs({ type: 'leave-channel' });
    closeAllPeerConnections();
    playBeep('switch');
  }
  hasSwitchedChannel = true;
  await ensureLocalStream();
  sendWs({ type: 'join-channel', channelName });
  document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
  const items = document.querySelectorAll('.channel-item');
  const chNames = Object.keys(serverState?.channels || {});
  const idx = chNames.indexOf(channelName);
  if (idx >= 0 && items[idx]) items[idx].classList.add('active');
}

function leaveServer() { cleanupAll(); window.location.href = '/'; }

// ── Event Listeners ──────────────────────────────────────────────────────────

// Landing form
joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = usernameInput.value.trim();
  const server = serverInput.value.trim().toLowerCase().replace(/\s+/g, '-');
  const pw = pwLanding.value;
  if (!name || !server) return;
  saveUsername(name);
  if (pw) sessionStorage.setItem(SS_PASSWORD, pw);
  window.location.href = `/server/${encodeURIComponent(server)}?username=${encodeURIComponent(name)}`;
});

// Recent servers
recentBtnLanding.addEventListener('click', showRecentModal);
recentBtnSidebar.addEventListener('click', showRecentModal);
recentModalClose.addEventListener('click', hideRecentModal);
recentModal.addEventListener('click', (e) => { if (e.target === recentModal) hideRecentModal(); });

// Password modal
passwordForm.addEventListener('submit', (e) => {
  e.preventDefault();
  serverPassword = pwModalInput.value.trim();
  if (!serverPassword) return;
  hidePasswordModal();
  connectWebSocket();
});
passwordModal.addEventListener('click', (e) => { if (e.target === passwordModal) hidePasswordModal(); });

// Rename modal
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

// Set password modal
setPwBtn.addEventListener('click', showSetPwModal);
setPwForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const pw = setPwInput.value.trim();
  sendWs({ type: 'set-password', password: pw || null });
  hideSetPwModal();
});
setPwModal.addEventListener('click', (e) => { if (e.target === setPwModal) hideSetPwModal(); });

// Chat
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !currentChannel) return;
  sendWs({ type: 'chat-message', message: text });
  chatInput.value = '';
});

// Add channel
addChannelForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = newChannelInput.value.trim();
  if (!name) return;
  sendWs({ type: 'add-channel', channelName: name });
  newChannelInput.value = '';
});

// Mute / Deafen
muteBtn.addEventListener('click', () => {
  isMuted = !isMuted;
  muteBtn.classList.toggle('active', isMuted);
  muteBtn.querySelector('.label').textContent = isMuted ? 'Muted' : 'Mute';
  muteBtn.querySelector('.icon').textContent = isMuted ? '🔇' : '🎙️';
  applyMuteState();
});

deafenBtn.addEventListener('click', () => {
  isDeafened = !isDeafened;
  deafenBtn.classList.toggle('active', isDeafened);
  deafenBtn.querySelector('.label').textContent = isDeafened ? 'Deafened' : 'Deafen';
  deafenBtn.querySelector('.icon').textContent = isDeafened ? '🔇' : '🔊';
  applyDeafenState();
});

leaveServerBtn.addEventListener('click', leaveServer);

// Escape closes modals
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
  if (ws) { try { ws.close(); } catch (e) { /* ignore */ } }
});

// ── Chat ─────────────────────────────────────────────────────────────────────
function addChatMessage(senderId, senderName, message, timestamp, isSystem) {
  const div = document.createElement('div');
  div.className = 'chat-msg' + (isSystem ? ' system' : '');
  const time = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isSystem) {
    div.innerHTML = `<span class="msg-text">${escapeHtml(message)}</span>`;
  } else {
    const isSelf = senderId === userId;
    div.innerHTML = `<span class="msg-author">${isSelf ? 'You' : escapeHtml(senderName)}</span><span class="msg-text">${escapeHtml(message)}</span><span class="msg-time">${time}</span>`;
  }
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function escapeHtml(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }

function formatTimeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
