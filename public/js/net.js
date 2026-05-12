// ── Signaling (WebSocket) ───────────────────────────────────────────────────
// Manages the WebSocket connection to the signaling server.
// Depends on: config.js

let ws = null;
let _onMessage = null;
let _onBinary = null;

function connectWebSocket(serverName, username, password, onMessage) {
  _onMessage = onMessage;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  if (ws) { try { ws.close(); } catch (e) { /* ignore */ } }

  setConnectionStatus('connecting', 'Connecting...');
  ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    setConnectionStatus('connected', 'Connected');
    const msg = { type: 'join-server', serverName, username };
    if (password) msg.password = password;
    ws.send(JSON.stringify(msg));
  };

  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      if (_onBinary) _onBinary(e.data);
    } else if (_onMessage) {
      _onMessage(JSON.parse(e.data));
    }
  };

  ws.onclose = () => {
    setConnectionStatus('disconnected', 'Disconnected');
    if (_onMessage) _onMessage({ type: '__disconnected' });
  };

  ws.onerror = () => {
    setConnectionStatus('disconnected', 'Error');
  };
}

function onBinaryMessage(fn) { _onBinary = fn; }

function sendWs(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function sendWsBinary(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(data);
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
