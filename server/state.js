// ── In-memory server state ──────────────────────────────────────────────────
// All "servers" (rooms), channels, users and socket bookkeeping live here.
// No database — a server lives as long as at least one user is in it
// (users in their reconnect grace period count).
//
// createState(config) returns an isolated instance, so tests can run many
// independent states in one process.

const WebSocket = require('ws');
const crypto = require('crypto');
const { DECEPTIVE_CHARS } = require('./security');

// ── Pure helpers ────────────────────────────────────────────────────────────

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return true;
  if (typeof password !== 'string' || !password) return false;
  try {
    const [salt, hash] = stored.split(':');
    const verify = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return expected.length === verify.length && crypto.timingSafeEqual(expected, verify);
  } catch {
    return false;
  }
}

const SCRYPT_KEYLEN = 64;

function scryptAsync(password, salt) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, (err, key) => (err ? reject(err) : resolve(key))));
}

async function hashPasswordAsync(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scryptAsync(password, salt);
  return `${salt}:${hash.toString('hex')}`;
}

async function verifyPasswordAsync(password, stored) {
  if (!stored) return true;
  if (typeof password !== 'string' || !password) return false;
  try {
    const [salt, hash] = stored.split(':');
    const expected = Buffer.from(hash, 'hex');
    const verify = await scryptAsync(password, salt);
    return expected.length === verify.length && crypto.timingSafeEqual(expected, verify);
  } catch {
    return false;
  }
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Trimmed, non-empty, length-limited string without control characters.
function validateString(value, maxLen) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen) return null;
  if (/[\x00-\x1F\x7F]/.test(trimmed)) return null;
  if (DECEPTIVE_CHARS.test(trimmed)) return null;   // bidi overrides / zero-width
  return trimmed;
}

const AVATAR_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/;
function validateAvatar(value, maxLen) {
  if (typeof value !== 'string' || value.length > maxLen) return null;
  return AVATAR_RE.test(value) ? value : null;
}

function channelKeyFor(name) {
  return name.toLowerCase().replace(/\s+/g, '-');
}

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ── State factory ───────────────────────────────────────────────────────────

function createState(config) {
  const L = config.limits;
  const servers = new Map();   // name → Server
  const sockets = new Map();   // ws → { ip, user: User|null }
  const ipCounts = new Map();  // ip → open socket count
  let nextUserId = 1;

  // ── Sockets / per-IP accounting ──────────────────────────────────────────

  function registerSocket(ws, ip, host = null) {
    if (sockets.size >= L.maxConnections) return 'MAX_CONNECTIONS';
    if ((ipCounts.get(ip) || 0) >= L.maxConnectionsPerIp) return 'MAX_CONNECTIONS_PER_IP';
    sockets.set(ws, { ip, host, user: null });
    ipCounts.set(ip, (ipCounts.get(ip) || 0) + 1);
    return null;
  }

  function unregisterSocket(ws) {
    const info = sockets.get(ws);
    if (!info) return null;
    sockets.delete(ws);
    const n = (ipCounts.get(info.ip) || 1) - 1;
    if (n <= 0) ipCounts.delete(info.ip); else ipCounts.set(info.ip, n);
    return info;
  }

  function socketInfo(ws) { return sockets.get(ws) || null; }
  function userForSocket(ws) { return sockets.get(ws)?.user || null; }

  function attachSocket(ws, user) {
    const info = sockets.get(ws);
    if (info) info.user = user;
    user.ws = ws;
  }

  // Detach the socket from its user (the user itself stays).
  function detachSocket(ws) {
    const info = sockets.get(ws);
    const user = info?.user || null;
    if (info) info.user = null;
    if (user && user.ws === ws) user.ws = null;
    return user;
  }

  // ── Messaging ────────────────────────────────────────────────────────────

  function sendToUser(user, msg) {
    if (user?.ws) send(user.ws, msg);
  }

  function broadcastToServer(srv, msg, excludeUserId = null) {
    if (!srv) return;
    const data = JSON.stringify(msg);
    for (const u of srv.users.values()) {
      if (u.id !== excludeUserId && u.ws && u.ws.readyState === WebSocket.OPEN) u.ws.send(data);
    }
  }

  function broadcastToChannel(srv, channelKey, msg, excludeUserId = null) {
    const ch = srv?.channels.get(channelKey);
    if (!ch) return;
    const data = JSON.stringify(msg);
    for (const id of ch.users) {
      if (id === excludeUserId) continue;
      const u = srv.users.get(id);
      if (u?.ws && u.ws.readyState === WebSocket.OPEN) u.ws.send(data);
    }
  }

  // ── Servers ──────────────────────────────────────────────────────────────

  function getServer(name) { return servers.get(name) || null; }
  function serverCount() { return servers.size; }

  function serversCreatedByIp(ip) {
    let n = 0;
    for (const srv of servers.values()) if (srv.createdByIp === ip) n++;
    return n;
  }

  function createServer(name, { password = null, passwordHash = null, ip = null } = {}) {
    const srv = {
      name,
      creatorId: null,
      passwordHash: passwordHash || (password ? hashPassword(password) : null),
      bannedIps: new Set(),
      relayOnly: false,
      maxUsers: L.maxUsersPerServer,
      maxUsersPerChannel: L.maxUsersPerChannel,
      createdByIp: ip,
      channels: new Map(),
      users: new Map(),
    };
    for (const cname of ['Lobby', 'Channel 1', 'Channel 2']) {
      // Keep historical keys ("lobby", "channel 1") for link compatibility.
      const key = cname.toLowerCase();
      srv.channels.set(key, { key, name: cname, users: new Set() });
    }
    servers.set(name, srv);
    return srv;
  }

  function relayEnforced(srv) {
    return !!(config.ice.forceRelay || srv?.relayOnly);
  }

  function checkPassword(srv, pw) {
    if (!srv || !srv.passwordHash) return true;
    return verifyPassword(pw, srv.passwordHash);
  }

  function setPassword(srv, pw) {
    srv.passwordHash = pw ? hashPassword(pw) : null;
    return !!srv.passwordHash;
  }

  // ── Users ────────────────────────────────────────────────────────────────

  function addUser(srv, { username, avatar = null, ip = null, relayOnly = false }) {
    const user = {
      id: String(nextUserId++),
      username,
      serverName: srv.name,
      channelKey: null,
      isMuted: false,
      isDeafened: false,
      avatar,
      relayOnly: !!relayOnly,
      ip,
      ws: null,
      token: crypto.randomBytes(16).toString('hex'),
      graceTimer: null,
    };
    srv.users.set(user.id, user);
    if (!srv.creatorId) srv.creatorId = user.id;
    return user;
  }

  function getUser(srv, userId) {
    return srv?.users.get(String(userId)) || null;
  }

  // Removes the user; deletes the server when it becomes empty.
  // Returns { srv, channelKey, serverDeleted }.
  function removeUser(user) {
    const srv = servers.get(user.serverName);
    if (user.graceTimer) { clearTimeout(user.graceTimer); user.graceTimer = null; }
    if (!srv || srv.users.get(user.id) !== user) return { srv: null, channelKey: null, serverDeleted: false };
    const channelKey = user.channelKey;
    if (channelKey) srv.channels.get(channelKey)?.users.delete(user.id);
    user.channelKey = null;
    srv.users.delete(user.id);
    let serverDeleted = false;
    if (srv.users.size === 0) {
      servers.delete(srv.name);
      serverDeleted = true;
    }
    return { srv, channelKey, serverDeleted };
  }

  // ── Channels ─────────────────────────────────────────────────────────────

  function channelFull(srv, key) {
    const ch = srv.channels.get(key);
    return !!ch && ch.users.size >= srv.maxUsersPerChannel;
  }

  function joinChannel(srv, user, key) {
    const ch = srv.channels.get(key);
    if (!ch) return null;
    const oldKey = user.channelKey;
    if (oldKey && oldKey !== key) srv.channels.get(oldKey)?.users.delete(user.id);
    ch.users.add(user.id);
    user.channelKey = key;
    return { oldKey: oldKey === key ? null : oldKey };
  }

  function leaveChannel(srv, user) {
    const oldKey = user.channelKey;
    if (!oldKey) return null;
    srv.channels.get(oldKey)?.users.delete(user.id);
    user.channelKey = null;
    return oldKey;
  }

  // Returns the new key, or an error code string.
  function addChannel(srv, name) {
    if (srv.channels.size >= L.maxChannelsPerServer) return { error: 'CHANNEL_LIMIT' };
    const key = channelKeyFor(name);
    if (srv.channels.has(key)) return { error: 'CHANNEL_EXISTS' };
    srv.channels.set(key, { key, name, users: new Set() });
    return { key };
  }

  function channelPeers(srv, key, excludeId) {
    const ch = srv.channels.get(key);
    if (!ch) return [];
    return [...ch.users].filter(id => id !== excludeId).map(id => srv.users.get(id)).filter(Boolean);
  }

  // ── Snapshots ────────────────────────────────────────────────────────────

  function publicUser(u) {
    return {
      userId: u.id, username: u.username, channelName: u.channelKey,
      isMuted: u.isMuted, isDeafened: u.isDeafened, avatar: u.avatar,
    };
  }

  function serverSettings(srv) {
    return {
      hasPassword: !!srv.passwordHash,
      relayOnly: srv.relayOnly,
      forceRelay: relayEnforced(srv),
      relayAvailable: config.ice.relayAvailable,
      maxUsers: srv.maxUsers,
      maxUsersPerChannel: srv.maxUsersPerChannel,
      limits: {
        maxUsersPerServer: L.maxUsersPerServer,
        maxUsersPerChannel: L.maxUsersPerChannel,
        maxChannelsPerServer: L.maxChannelsPerServer,
      },
    };
  }

  function buildServerState(srv) {
    const channels = {};
    for (const [key, ch] of srv.channels) {
      const users = {};
      for (const id of ch.users) {
        const u = srv.users.get(id);
        if (u) users[id] = { userId: id, username: u.username };
      }
      channels[key] = { name: ch.name, users };
    }
    const users = {};
    for (const u of srv.users.values()) users[u.id] = publicUser(u);
    return {
      type: 'server-state',
      serverName: srv.name,
      creator: srv.creatorId,
      ...serverSettings(srv),
      channels,
      users,
    };
  }

  return {
    // sockets
    registerSocket, unregisterSocket, socketInfo, userForSocket, attachSocket, detachSocket,
    // messaging
    send, sendToUser, broadcastToServer, broadcastToChannel,
    // servers
    getServer, serverCount, serversCreatedByIp, createServer, relayEnforced,
    checkPassword, setPassword,
    // users
    addUser, getUser, removeUser,
    // channels
    channelFull, joinChannel, leaveChannel, addChannel, channelPeers,
    // snapshots
    publicUser, serverSettings, buildServerState,
    // introspection (tests / health)
    stats: () => ({ servers: servers.size, connections: sockets.size }),
    _servers: servers,
  };
}

module.exports = {
  createState,
  hashPassword, verifyPassword, hashPasswordAsync, verifyPasswordAsync, safeEqual, validateString, validateAvatar, channelKeyFor, send,
};
