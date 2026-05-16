// ── Signaling (WebSocket) ───────────────────────────────────────────────────
// Manages the WebSocket connection to the signaling server.
// Depends on: config.js

let ws = null;
let _onMessage = null;

function connectWebSocket(serverName, username, password, onMessage) {
  _onMessage = onMessage;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  if (ws) { try { ws.close(); } catch (e) { /* ignore */ } }

  setConnectionStatus('connecting', 'Connecting...');
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    setConnectionStatus('connected', 'Connected');
    const msg = { type: 'join-server', serverName, username };
    if (password) msg.password = password;
    // Attach avatar if set
    const avatar = localStorage.getItem('ezspeak_avatar');
    if (avatar) msg.avatar = avatar;
    ws.send(JSON.stringify(msg));
  };

  ws.onmessage = (e) => {
    if (_onMessage) _onMessage(JSON.parse(e.data));
  };

  ws.onclose = () => {
    setConnectionStatus('disconnected', 'Disconnected');
    if (_onMessage) _onMessage({ type: '__disconnected' });
  };

  ws.onerror = () => {
    setConnectionStatus('disconnected', 'Error');
  };
}

function sendWs(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function closeWs() {
  if (ws) { try { ws.close(); } catch (e) { /* ignore */ } ws = null; }
}

// Connection status UI — set by ui.js
let _setConnStatus = null;
function onConnectionStatusChange(fn) { _setConnStatus = fn; }
function setConnectionStatus(status, text) {
  if (_setConnStatus) _setConnStatus(status, text);
}
