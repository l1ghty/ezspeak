const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const handlers = require('./server/handlers');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, maxPayload: 65536 });  // 64 KB max message

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

// ── Security headers ────────────────────────────────────────────────────────

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy':
      "default-src 'self'; " +
      "script-src 'self'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "connect-src 'self' ws: wss:; " +
      "media-src 'self' blob:; " +
      "img-src 'self' data: blob:; " +
      "font-src 'self'",
  });
  next();
});

// ── Static files (no caching during development) ───────────────────────────

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
}));
const indexHtml = require('fs').readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
  .replace('{{BUILD_TIME}}', 'build-date: ' + BUILD_TIME);

app.get('/server/:name', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.type('html').send(indexHtml);
});

// ── Connection limits ───────────────────────────────────────────────────────

const MAX_CONNECTIONS = 500;
let connectionCount = 0;

// ── WebSocket ───────────────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  // Connection limit
  if (connectionCount >= MAX_CONNECTIONS) {
    ws.close(1013, 'Server full — try again later');
    return;
  }
  connectionCount++;

  let context = { userId: null, username: null, serverName: null };
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

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
    connectionCount--;
    handlers.handleDisconnect(ws);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

// ── Idle timeout (kick unresponsive clients) ────────────────────────────────

const IDLE_PING_INTERVAL = 30000; // 30 seconds
const idleInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('Terminating idle connection');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, IDLE_PING_INTERVAL);

server.on('close', () => clearInterval(idleInterval));

// ── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎤 ezspeak running on http://localhost:${PORT}`);
  console.log(`   Join a server: http://localhost:${PORT}/server/myserver`);
  console.log(`   Firefox? Try:    http://127.0.0.1:${PORT}/server/myserver`);
});
