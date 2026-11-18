// Test helpers: spin up an isolated ezspeak instance and drive it with
// real WebSocket clients.
const WebSocket = require('ws');
const { loadConfig } = require('../../server/config');
const { createApp } = require('../../server/app');

const quietLog = { log() {}, warn() {}, error() {} };

async function startServer(env = {}) {
  const config = loadConfig({ PORT: '0', ...env });
  const instance = createApp(config, { log: quietLog });
  const port = await instance.listen(0);
  return { ...instance, config, port, url: `ws://127.0.0.1:${port}`, http: `http://127.0.0.1:${port}` };
}

class Client {
  constructor(url, headers) {
    this.messages = [];
    this.waiters = [];
    this.ws = new WebSocket(url, { headers });
    this.closed = new Promise((resolve) => this.ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      this.messages.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(msg)) { w.resolve(msg); return false; }
        return true;
      });
    });
  }
  open() {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve(this);
      this.ws.once('open', () => resolve(this));
      this.ws.once('error', reject);
      this.ws.once('close', () => reject(new Error('closed before open')));
    });
  }
  send(msg) { this.ws.send(JSON.stringify(msg)); }
  // Wait for the next message (already received or future) matching type/predicate.
  next(type, pred = () => true, timeout = 2000) {
    const types = Array.isArray(type) ? type : [type];
    const match = (m) => types.includes(m.type) && pred(m);
    const idx = this.messages.findIndex(match);
    if (idx >= 0) return Promise.resolve(this.messages.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeout);
      this.waiters.push({ pred: match, resolve: (m) => { clearTimeout(t); this.messages.splice(this.messages.indexOf(m), 1); resolve(m); } });
    });
  }
  // Resolve true if no matching message arrives within `ms`.
  async none(type, ms = 150) {
    try { await this.next(type, () => true, ms); return false; } catch { return true; }
  }
  close() { this.ws.close(); return this.closed; }
}

async function connect(srv, headers) {
  return new Client(srv.url, headers).open();
}

async function join(srv, serverName, username, extra = {}) {
  const c = await connect(srv, extra.headers);
  const { headers, ...rest } = extra;
  c.send({ type: 'join-server', serverName, username, ...rest });
  const first = await c.next(['server-state', 'error', 'password-required']);
  c.state = first;
  c.id = first.yourUserId;
  return c;
}

async function joinChannel(c, channelName) {
  c.send({ type: 'join-channel', channelName });
  return c.next('joined-channel');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { startServer, Client, connect, join, joinChannel, sleep, quietLog };
