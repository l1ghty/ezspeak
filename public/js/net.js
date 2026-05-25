// ── Signaling (WebSocket) ───────────────────────────────────────────────────
// Manages the WebSocket connection to the signaling server.
// Depends on: config.js

let ws = null;
let _onMessage = null;

// ── Reconnection state ──────────────────────────────────────────────────────

let reconnectToken = null;
let reconnectUserId = null;
let reconnectServerName = null;
let reconnectUsername = null;
let reconnectPassword = null;
let _intentionalClose = false;
let _reconnectAttempt = 0;
let _reconnectTimer = null;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_DELAY = 1000;   // start at 1 second
const RECONNECT_MAX_DELAY = 30000;   // cap at 30 seconds

function saveReconnectInfo(serverName, userId, username, password, token) {
  reconnectServerName = serverName;
  reconnectUserId = userId;
  reconnectUsername = username;
  reconnectPassword = password;
  reconnectToken = token;
  // Also persist in sessionStorage for full-page reload recovery
  try {
    sessionStorage.setItem('ezspeak_reconnect_server', serverName);
    sessionStorage.setItem('ezspeak_reconnect_user', userId);
    sessionStorage.setItem('ezspeak_reconnect_name', username);
    sessionStorage.setItem('ezspeak_reconnect_token', token);
    sessionStorage.setItem('ezspeak_reconnect_ts', Date.now());
    if (password) sessionStorage.setItem('ezspeak_reconnect_pw', password);
  } catch (e) { /* ignore */ }
}

function clearReconnectInfo() {
  reconnectToken = null;
  reconnectUserId = null;
  reconnectServerName = null;
  reconnectUsername = null;
  reconnectPassword = null;
  try {
    sessionStorage.removeItem('ezspeak_reconnect_server');
    sessionStorage.removeItem('ezspeak_reconnect_user');
    sessionStorage.removeItem('ezspeak_reconnect_name');
    sessionStorage.removeItem('ezspeak_reconnect_token');
    sessionStorage.removeItem('ezspeak_reconnect_ts');
    sessionStorage.removeItem('ezspeak_reconnect_pw');
  } catch (e) { /* ignore */ }
}

// Reconnect info older than this is considered stale (ms)
const RECONNECT_MAX_AGE = 120000; // 2 minutes

function hasReconnectInfo() {
  return !!(reconnectToken && reconnectUserId && reconnectServerName);
}

function stopReconnect() {
  _reconnectAttempt = 0;
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
}

function attemptReconnect() {
  if (_reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    console.log('[net] Max reconnect attempts reached, giving up');
    clearReconnectInfo();
    if (_onMessage) _onMessage({ type: '__reconnect_failed' });
    return;
  }

  _reconnectAttempt++;
  const delay = Math.min(
    RECONNECT_BASE_DELAY * Math.pow(2, _reconnectAttempt - 1),
    RECONNECT_MAX_DELAY
  );
  // Add jitter: ±20%
  const jitter = delay * 0.2 * (Math.random() * 2 - 1);
  const finalDelay = Math.round(delay + jitter);

  console.log(`[net] Reconnect attempt ${_reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS} in ${finalDelay}ms`);

  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    setConnectionStatus('connecting', 'Reconnecting...');

    // Build reconnect request
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    if (ws) { try { ws.close(); } catch (e) { /* ignore */ } }

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setConnectionStatus('connected', 'Connected');
      // If we have a reconnect token, use it
      if (hasReconnectInfo()) {
        ws.send(JSON.stringify({
          type: 'reconnect-session',
          serverName: reconnectServerName,
          userId: reconnectUserId,
          reconnectToken: reconnectToken
        }));
      } else if (reconnectServerName && reconnectUsername) {
        // Fallback: regular join (no token — will get new session)
        const msg = { type: 'join-server', serverName: reconnectServerName, username: reconnectUsername };
        if (reconnectPassword) msg.password = reconnectPassword;
        const avatar = localStorage.getItem('ezspeak_avatar');
        if (avatar) msg.avatar = avatar;
        ws.send(JSON.stringify(msg));
      }
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      // On successful reconnect or server-state, stop reconnect loop
      if (msg.type === 'server-state') {
        stopReconnect();
        _reconnectAttempt = 0;
      }
      if (_onMessage) _onMessage(msg);
    };

    ws.onclose = () => {
      setConnectionStatus('disconnected', 'Disconnected');
      // Only retry if we still have reconnect info and this wasn't intentional
      if (!_intentionalClose && hasReconnectInfo()) {
        attemptReconnect();
      } else if (!_intentionalClose) {
        if (_onMessage) _onMessage({ type: '__disconnected' });
      }
    };

    ws.onerror = () => {
      // Don't set disconnected here; onclose will fire next
    };
  }, finalDelay);
}

// ── Public API ──────────────────────────────────────────────────────────────

function connectWebSocket(serverName, username, password, onMessage) {
  _onMessage = onMessage;
  _intentionalClose = false;
  stopReconnect();

  // Check for stored reconnect info from a previous page load
  // Only use it if it's fresh (< 2 minutes old)
  try {
    const storedServer = sessionStorage.getItem('ezspeak_reconnect_server');
    const storedUser = sessionStorage.getItem('ezspeak_reconnect_user');
    const storedName = sessionStorage.getItem('ezspeak_reconnect_name');
    const storedToken = sessionStorage.getItem('ezspeak_reconnect_token');
    const storedTs = parseInt(sessionStorage.getItem('ezspeak_reconnect_ts') || '0', 10);
    const storedPw = sessionStorage.getItem('ezspeak_reconnect_pw');
    if (storedServer && storedUser && storedName && storedToken && (Date.now() - storedTs < RECONNECT_MAX_AGE)) {
      reconnectServerName = storedServer;
      reconnectUserId = storedUser;
      reconnectUsername = storedName;
      reconnectToken = storedToken;
      reconnectPassword = storedPw || password;
    } else if (storedServer) {
      // Stale info — clean up
      clearReconnectInfo();
    }
  } catch (e) { /* ignore */ }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  if (ws) { try { ws.close(); } catch (e) { /* ignore */ } }

  setConnectionStatus('connecting', 'Connecting...');
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    setConnectionStatus('connected', 'Connected');
    // If we have reconnect info from a previous session, try that first
    if (hasReconnectInfo() && reconnectServerName === serverName) {
      ws.send(JSON.stringify({
        type: 'reconnect-session',
        serverName: reconnectServerName,
        userId: reconnectUserId,
        reconnectToken: reconnectToken
      }));
    } else {
      // Clear any stale reconnect info
      clearReconnectInfo();
      const msg = { type: 'join-server', serverName, username };
      if (password) msg.password = password;
      const avatar = localStorage.getItem('ezspeak_avatar');
      if (avatar) msg.avatar = avatar;
      ws.send(JSON.stringify(msg));
    }
  };

  ws.onmessage = (e) => {
    if (_onMessage) _onMessage(JSON.parse(e.data));
  };

  ws.onclose = () => {
    setConnectionStatus('disconnected', 'Disconnected');
    // Auto-reconnect on unexpected close
    if (!_intentionalClose && (hasReconnectInfo() || reconnectServerName)) {
      attemptReconnect();
    } else if (!_intentionalClose) {
      if (_onMessage) _onMessage({ type: '__disconnected' });
    }
  };

  ws.onerror = () => {
    // Don't set disconnected here; onclose will fire next
  };
}

function sendWs(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function closeWs() {
  _intentionalClose = true;
  stopReconnect();
  clearReconnectInfo();
  if (ws) { try { ws.close(); } catch (e) { /* ignore */ } ws = null; }
}

// Connection status UI — set by ui.js
let _setConnStatus = null;
function onConnectionStatusChange(fn) { _setConnStatus = fn; }
function setConnectionStatus(status, text) {
  if (_setConnStatus) _setConnStatus(status, text);
}
