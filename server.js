const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const handlers = require('./server/handlers');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ── Build timestamp (latest git commit, fallback to current time) ─────────

let BUILD_TIME;
try {
  const { execSync } = require('child_process');
  BUILD_TIME = execSync('git log -1 --format=%ci', { encoding: 'utf8' }).trim().slice(0, 16);
} catch (_) {
  // Try .git-commit-date file (written by Docker build)
  try {
    BUILD_TIME = require('fs').readFileSync(path.join(__dirname, '.git-commit-date'), 'utf8').trim().slice(0, 16);
  } catch (_) {
    BUILD_TIME = new Date().toISOString().replace('T', ' ').slice(0, 16);
  }
}

// ── Static files (no caching during development) ───────────────────────────

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
}));
const indexHtml = require('fs').readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
  .replace('{{BUILD_TIME}}', BUILD_TIME);

app.get('/server/:name', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.type('html').send(indexHtml);
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
