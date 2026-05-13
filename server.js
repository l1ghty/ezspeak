const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const handlers = require('./server/handlers');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ── Static files (no caching during development) ───────────────────────────

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
}));
app.get('/server/:name', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── WebSocket ───────────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  let context = { userId: null, username: null, serverName: null };

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    try {
      if (msg.type === 'join-server') {
        context = handlers.route(ws, msg) || context;
      } else {
        handlers.route(ws, msg, context);
      }
    } catch (err) {
      console.error('Handler error:', msg.type, err.message);
    }
  });

  ws.on('close', () => {
    handlers.handleDisconnect(ws);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

// ── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎤 ezspeak running on http://localhost:${PORT}`);
  console.log(`   Join a server: http://localhost:${PORT}/server/myserver`);
  console.log(`   Firefox? Try:    http://127.0.0.1:${PORT}/server/myserver`);
});
