// ── HTTP + WebSocket application factory ────────────────────────────────────
// createApp(config) wires Express, the WebSocket server, state and handlers
// together without listening, so tests can start isolated instances on
// ephemeral ports.

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { createState } = require('./state');
const { createHandlers } = require('./handlers');
const { normalizeServerName } = require('../public/js/shared');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function readBuildTime() {
  try {
    const { execSync } = require('child_process');
    return execSync('git log -1 --format=%ci', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().slice(0, 16);
  } catch {
    try {
      return fs.readFileSync(path.join(__dirname, '..', '.git-commit-date'), 'utf8').trim().slice(0, 16);
    } catch {
      return new Date().toISOString().replace('T', ' ').slice(0, 16);
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function createApp(config, { log = console } = {}) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server, maxPayload: 64 * 1024 });
  const state = createState(config);
  const handlers = createHandlers(state, config, log);

  if (config.trustProxy) app.set('trust proxy', true);

  const indexHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
    .replace('{{BUILD_TIME}}', () => 'build-date: ' + readBuildTime());

  function renderIndex(req, title, desc, pageUrl) {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    return indexHtml
      .replace('{{OG_TITLE}}', () => escapeHtml(title))
      .replace('{{OG_DESC}}', () => escapeHtml(desc))
      .replace('{{OG_IMAGE}}', () => escapeHtml(baseUrl + '/favicon.png'))
      .replace('{{OG_URL}}', () => escapeHtml(pageUrl || baseUrl));
  }

  const noStore = (res) => res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
  });

  // ── Security headers ──────────────────────────────────────────────────────
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "connect-src 'self' ws: wss:; media-src 'self' blob:; img-src 'self' data: blob:; font-src 'self'",
    });
    next();
  });

  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', uptime: process.uptime() });
  });

  app.get('/', (req, res) => {
    noStore(res);
    res.type('html').send(renderIndex(req, 'ezspeak — simple voice chat',
      'Simple voice chat. No downloads. Create a server and talk.'));
  });

  app.use(express.static(PUBLIC_DIR, { index: false, setHeaders: noStore }));

  app.get('/server/:name', (req, res) => {
    const sanitized = normalizeServerName(req.params.name);
    if (!sanitized || sanitized.length > config.limits.serverNameMax) return res.redirect(302, '/');
    if (req.params.name !== sanitized) return res.redirect(301, '/server/' + encodeURIComponent(sanitized));
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    noStore(res);
    res.type('html').send(renderIndex(req, sanitized + ' – ezspeak',
      'Join ' + sanitized + ' on ezspeak — simple voice chat. No downloads.',
      `${baseUrl}/server/${encodeURIComponent(sanitized)}`));
  });

  // ── WebSocket ─────────────────────────────────────────────────────────────
  wss.on('connection', (ws, req) => {
    const ip = clientIp(req, config.trustProxy);
    const refused = state.registerSocket(ws, ip);
    if (refused) {
      ws.close(1013, refused === 'MAX_CONNECTIONS_PER_IP'
        ? 'Too many connections from your network' : 'Server full — try again later');
      return;
    }

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      ws.isAlive = true;
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      try {
        handlers.route(ws, msg);
      } catch (err) {
        log.error('Handler error:', msg && msg.type, err && err.stack || err);
      }
    });
    ws.on('close', () => handlers.handleClose(ws));
    ws.on('error', (err) => log.error('WebSocket error:', err.message));
  });

  // Kick sockets that stopped answering pings.
  const pingTimer = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    });
  }, config.pingIntervalMs);
  pingTimer.unref?.();

  function listen(port = config.port) {
    return new Promise((resolve) => server.listen(port, () => resolve(server.address().port)));
  }

  function close() {
    clearInterval(pingTimer);
    for (const ws of wss.clients) ws.terminate();
    return new Promise((resolve) => wss.close(() => server.close(() => resolve())));
  }

  return { app, server, wss, state, handlers, listen, close };
}

module.exports = { createApp, escapeHtml, clientIp };
