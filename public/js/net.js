// ── Signaling (WebSocket) ───────────────────────────────────────────────────
// One WebSocket to the signaling server with automatic reconnect.
// After a drop we resume the same session (same userId / channel) with the
// reconnect token; the server keeps us for a grace period.
// Depends on: shared.js, config.js

let ws = null;
let _onMessage = null;
let _target = null;               // { serverName, username, password }
let _intentionalClose = false;
let _reconnectAttempt = 0;
let _reconnectTimer = null;

// Resume info (also kept in sessionStorage for bfcache / quick reloads)
let reconnectToken = null;
let reconnectUserId = null;
let reconnectServerName = null;

const MAX_RECONNECT_ATTEMPTS = 30;  // ~6 minutes with the 15 s cap
const RECONNECT_MAX_AGE = 120000;   // stored resume info older than this is stale

function saveReconnectInfo(serverName, userId, username, password, token) {
  reconnectServerName = serverName;
  reconnectUserId = userId;
  reconnectToken = token;
  try {
    sessionStorage.setItem('ezspeak_reconnect', JSON.stringify({ serverName, userId, token, ts: Date.now() }));
  } catch (e) { /* ignore */ }
}

function clearReconnectInfo() {
  reconnectToken = reconnectUserId = reconnectServerName = null;
  try { sessionStorage.removeItem('ezspeak_reconnect'); } catch (e) { /* ignore */ }
}

function loadStoredReconnectInfo(serverName) {
  try {
    const raw = sessionStorage.getItem('ezspeak_reconnect');
    if (!raw) return;
    const info = JSON.parse(raw);
    if (info.serverName === serverName && Date.now() - info.ts < RECONNECT_MAX_AGE) {
      reconnectServerName = info.serverName;
      reconnectUserId = info.userId;
      reconnectToken = info.token;
    } else {
      clearReconnectInfo();
    }
  } catch (e) { clearReconnectInfo(); }
}

function hasReconnectInfo() {
  return !!(reconnectToken && reconnectUserId && reconnectServerName);
}

function relayPreference() {
  try { return localStorage.getItem(LS_RELAY_ONLY) === '1'; } catch { return false; }
}

function buildHelloMessage() {
  if (hasReconnectInfo() && reconnectServerName === _target.serverName) {
    return { type: 'reconnect-session', serverName: reconnectServerName, userId: reconnectUserId,
             reconnectToken, relayOnly: relayPreference() };
  }
  return buildJoinMessage();
}

function buildJoinMessage() {
  const msg = { type: 'join-server', serverName: _target.serverName, username: _target.username,
                relayOnly: relayPreference() };
  if (_target.password) msg.password = _target.password;
  const avatar = localStorage.getItem('ezspeak_avatar');
  if (avatar) msg.avatar = avatar;
  return msg;
}

// Send a fresh join on the current socket (used when resuming failed).
function sendJoin() {
  clearReconnectInfo();
  sendWs(buildJoinMessage());
}

function openSocket() {
  if (ws) {
    const old = ws;
    old.onopen = old.onmessage = old.onclose = old.onerror = null;
    try { old.close(); } catch (e) { /* ignore */ }
  }
  setConnectionStatus('connecting', _reconnectAttempt ? 'Reconnecting...' : 'Connecting...');
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const sock = new WebSocket(`${protocol}//${window.location.host}`);
  ws = sock;

  sock.onopen = () => {
    if (ws !== sock) return;
    setConnectionStatus('connected', 'Connected');
    sock.send(JSON.stringify(buildHelloMessage()));
  };

  sock.onmessage = (e) => {
    if (ws !== sock) return;
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'server-state') _reconnectAttempt = 0;
    if (_onMessage) _onMessage(msg);
  };

  sock.onclose = (ev) => {
    if (ws !== sock) return;
    ws = null;
    setConnectionStatus('disconnected', 'Disconnected');
    if (_intentionalClose) return;
    if (ev.code === 4000) {
      // Our session was resumed by another socket (e.g. another tab).
      if (_onMessage) _onMessage({ type: '__replaced' });
      return;
    }
    if (_onMessage) _onMessage({ type: '__disconnected' });
    scheduleReconnect();
  };

  sock.onerror = () => { /* onclose follows */ };
}

function scheduleReconnect() {
  if (_reconnectTimer || _intentionalClose) return;
  if (_reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    clearReconnectInfo();
    if (_onMessage) _onMessage({ type: '__reconnect_failed' });
    return;
  }
  _reconnectAttempt++;
  const delay = reconnectDelay(_reconnectAttempt, 1000, 15000);
  console.log(`[net] reconnect attempt ${_reconnectAttempt} in ${delay}ms`);
  setConnectionStatus('connecting', 'Reconnecting...');
  _reconnectTimer = setTimeout(() => { _reconnectTimer = null; openSocket(); }, delay);
}

function stopReconnect() {
  _reconnectAttempt = 0;
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
}

// Reconnect immediately (tab became visible, network came back, …).
function reconnectNow() {
  if (_intentionalClose || !_target) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  openSocket();
}

// Back-compat alias
function attemptReconnect() { reconnectNow(); }

// ── Public API ──────────────────────────────────────────────────────────────

function connectWebSocket(serverName, username, password, onMessage) {
  _onMessage = onMessage;
  _intentionalClose = false;
  _target = { serverName, username, password };
  stopReconnect();
  if (!hasReconnectInfo() || reconnectServerName !== serverName) loadStoredReconnectInfo(serverName);
  openSocket();
}

function sendWs(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

function closeWs() {
  _intentionalClose = true;
  stopReconnect();
  clearReconnectInfo();
  if (ws) {
    const old = ws;
    ws = null;
    old.onclose = null;
    try { old.close(); } catch (e) { /* ignore */ }
  }
}

function isWebSocketOpen() {
  return !!(ws && ws.readyState === WebSocket.OPEN);
}

// Connection status UI — set by ui.js
let _setConnStatus = null;
function onConnectionStatusChange(fn) { _setConnStatus = fn; }
function setConnectionStatus(status, text) {
  if (_setConnStatus) _setConnStatus(status, text);
}

window.addEventListener('online', () => reconnectNow());
