// ── In-memory server state ──────────────────────────────────────────────────
// All servers, channels, users, and client connections live here.
// No database — servers persist as long as at least one user is connected.

const WebSocket = require('ws');
const crypto = require('crypto');

const servers = {};  // serverName -> { name, creator, password|null, channels, users }
let nextUserId = 1;
const clients = new Map();  // ws -> { ws, userId, username, serverName }

// ── Input limits ────────────────────────────────────────────────────────────

const LIMITS = {
  USERNAME_MAX: 24,
  SERVER_NAME_MAX: 32,
  CHANNEL_NAME_MAX: 24,
  CHAT_MESSAGE_MAX: 2000,
  PASSWORD_MAX: 128,
  FILE_NAME_MAX: 255,
  MAX_SERVERS: 100,
  MAX_USERS_PER_SERVER: 200,
};

// ── Password hashing (scrypt via built-in crypto) ───────────────────────────

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return true;
  try {
    const [salt, hash] = stored.split(':');
    const verify = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(verify, 'hex'));
  } catch {
    return false;
  }
}

// ── Input validation helper ─────────────────────────────────────────────────

function validateString(value, maxLen) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen) return null;
  // Reject control characters (except spaces)
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(trimmed)) return null;
  return trimmed;
}

// ── Low-level messaging ─────────────────────────────────────────────────────

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastToServer(serverName, msg, excludeWs = null) {
  for (const [ws, client] of clients) {
    if (client.serverName === serverName && ws !== excludeWs) send(ws, msg);
  }
}

function broadcastToChannel(serverName, channelName, msg, excludeWs = null) {
  const srv = servers[serverName];
  if (!srv || !srv.channels[channelName]) return;
  const channelUsers = srv.channels[channelName].users;
  for (const [ws, client] of clients) {
    if (client.serverName === serverName && channelUsers[client.userId] && ws !== excludeWs) {
      send(ws, msg);
    }
  }
}

// Binary relay: forwards raw ArrayBuffer to all channel members except sender
function broadcastToChannelBinary(serverName, channelName, data, excludeWs = null) {
  const srv = servers[serverName];
  if (!srv || !srv.channels[channelName]) return;
  const channelUsers = srv.channels[channelName].users;
  for (const [ws, client] of clients) {
    if (client.serverName === serverName && channelUsers[client.userId] && ws !== excludeWs) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }
}

function getChannelUserCount(serverName, channelName) {
  const srv = servers[serverName];
  if (!srv?.channels[channelName]) return 0;
  return Object.keys(srv.channels[channelName].users).length;
}

// ── Server lifecycle ────────────────────────────────────────────────────────

function createServer(name, userId, password) {
  const srv = {
    name,
    creator: userId,
    password: password ? hashPassword(password) : null,
    channels: {
      'lobby':     { name: 'Lobby',     users: {} },
      'channel 1': { name: 'Channel 1', users: {} },
      'channel 2': { name: 'Channel 2', users: {} }
    },
    users: {}
  };
  servers[name] = srv;
  return srv;
}

function getServer(name) {
  return servers[name] || null;
}

function serverExists(name) {
  return !!servers[name];
}

function serverCount() {
  return Object.keys(servers).length;
}

// ── Reconnect tokens & grace period ─────────────────────────────────────────

const disconnectTimers = new Map(); // `${serverName}:${userId}` → { timer, ws }
const userTokens = new Map();      // `${serverName}:${userId}` → token
const DISCONNECT_GRACE_MS = 30000; // 30-second grace period for mobile users

function generateReconnectToken() {
  return crypto.randomBytes(16).toString('hex');
}

function getReconnectToken(serverName, userId) {
  const key = `${serverName}:${userId}`;
  return userTokens.get(key) || null;
}

function scheduleDisconnect(serverName, userId, oldWs) {
  const key = `${serverName}:${userId}`;
  cancelDisconnect(serverName, userId);

  // If user was already removed (intentional disconnect), don't schedule
  if (!getUser(serverName, userId)) return;

  const timer = setTimeout(() => {
    disconnectTimers.delete(key);
    userTokens.delete(key);
    const user = removeUser(serverName, userId);
    if (user?.channelName) {
      const srv = servers[serverName];
      if (srv?.channels[user.channelName]) {
        broadcastToChannel(serverName, user.channelName, {
          type: 'peer-left-channel',
          userId, username: user.username, channelName: user.channelName
        });
        const newMixer = recalculateMixer(serverName, user.channelName);
        broadcastToChannel(serverName, user.channelName, {
          type: 'mixer-changed', mixerId: newMixer
        });
      }
      broadcastToServer(serverName, {
        type: 'user-left-server', userId, username: user.username
      });
    }
    console.log(`[â°] Grace period expired for ${user?.username || userId} in "${serverName}"`);
  }, DISCONNECT_GRACE_MS);

  disconnectTimers.set(key, { timer, ws: oldWs });
  console.log(`[â] Grace period started for user ${userId} in "${serverName}" (${DISCONNECT_GRACE_MS / 1000}s)`);
}

function cancelDisconnect(serverName, userId) {
  const key = `${serverName}:${userId}`;
  const entry = disconnectTimers.get(key);
  if (entry) {
    clearTimeout(entry.timer);
    disconnectTimers.delete(key);
    if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
      try { entry.ws.close(); } catch (e) { /* ignore */ }
    }
    console.log(`[â] Grace period cancelled for user ${userId} in "${serverName}"`);
    return true;
  }
  return false;
}

function isUserInGrace(serverName, userId) {
  return disconnectTimers.has(`${serverName}:${userId}`);
}

// ── Reconnect: reassign WebSocket to an existing user in grace period ──────

function reconnectUser(serverName, userId, newWs) {
  const key = `${serverName}:${userId}`;
  const entry = disconnectTimers.get(key);
  if (!entry) return null;

  // Cancel the disconnect timer
  clearTimeout(entry.timer);
  disconnectTimers.delete(key);

  // Close the old WebSocket if still open
  if (entry.ws && entry.ws !== newWs && entry.ws.readyState === WebSocket.OPEN) {
    try { entry.ws.close(); } catch (e) { /* ignore */ }
  }

  // Register the new WebSocket for the existing user
  const user = getUser(serverName, userId);
  if (!user) return null;

  registerClient(newWs, { ws: newWs, userId, username: user.username, serverName });

  console.log(`[ð] User ${user.username} (${userId}) reconnected to "${serverName}"`);
  return user;
}

// ── User management ─────────────────────────────────────────────────────────

function nextId() {
  return String(nextUserId++);
}

function addUser(serverName, userId, username, avatar) {
  const srv = servers[serverName];
  if (!srv) return null;
  srv.users[userId] = { username, channelName: null, isMuted: false, isDeafened: false, avatar: avatar || null };
  // Generate reconnect token for this user
  const token = generateReconnectToken();
  userTokens.set(`${serverName}:${userId}`, token);
  return srv.users[userId];
}

function removeUser(serverName, userId) {
  const srv = servers[serverName];
  if (!srv) return null;
  const user = srv.users[userId];
  if (!user) return null;

  // Remove from channel if in one
  if (user.channelName && srv.channels[user.channelName]) {
    delete srv.channels[user.channelName].users[userId];
  }
  delete srv.users[userId];

  // Cleanup empty (zombie) server
  if (Object.keys(srv.users).length === 0) {
    delete servers[serverName];
    console.log(`[🧹] Server "${serverName}" removed (no users left)`);
  }

  return user;
}

function getUser(serverName, userId) {
  return servers[serverName]?.users[userId] || null;
}

function changeUsername(serverName, userId, newName) {
  const user = getUser(serverName, userId);
  if (!user) return null;
  const old = user.username;
  user.username = newName;
  // Update in channel too
  if (user.channelName && servers[serverName].channels[user.channelName]) {
    const chUser = servers[serverName].channels[user.channelName].users[userId];
    if (chUser) chUser.username = newName;
  }
  return { old, new: newName };
}

// ── Channel management ──────────────────────────────────────────────────────

function joinChannel(serverName, userId, channelName) {
  const srv = servers[serverName];
  if (!srv || !srv.channels[channelName]) return null;

  const user = srv.users[userId];
  if (!user) return null;

  // Leave current channel
  let oldChannel = null;
  if (user.channelName && srv.channels[user.channelName]) {
    oldChannel = user.channelName;
    delete srv.channels[user.channelName].users[userId];
  }

  // Join new
  user.channelName = channelName;
  srv.channels[channelName].users[userId] = { userId, username: user.username };

  return { oldChannel, channelName };
}

// Recalculate mixer after channel change — returns new mixerId or null
function recalculateMixer(serverName, channelName) {
  const srv = servers[serverName];
  if (!srv?.channels[channelName]) return null;
  const userIds = Object.keys(srv.channels[channelName].users);
  if (userIds.length >= 3) {
    // First user in channel is mixer (stable — oldest joiner)
    return userIds[0];
  }
  return null;
}

function leaveChannel(serverName, userId) {
  const srv = servers[serverName];
  if (!srv) return null;
  const user = srv.users[userId];
  if (!user?.channelName) return null;

  const name = user.channelName;
  if (srv.channels[name]) delete srv.channels[name].users[userId];
  user.channelName = null;
  return name;
}

function addChannel(serverName, channelName) {
  const srv = servers[serverName];
  if (!srv) return null;
  const key = channelName.toLowerCase().replace(/\s+/g, '-');
  if (srv.channels[key]) return null;
  srv.channels[key] = { name: channelName, users: {} };
  return key;
}

function getChannelPeers(serverName, channelName, excludeUserId) {
  const srv = servers[serverName];
  if (!srv?.channels[channelName]) return [];
  return Object.keys(srv.channels[channelName].users).filter(id => id !== excludeUserId);
}

// ── Password ────────────────────────────────────────────────────────────────

function checkPassword(serverName, pw) {
  const srv = servers[serverName];
  if (!srv) return true;       // server doesn't exist yet — will be created
  if (!srv.password) return true;  // no password set
  if (!pw) return false;       // password required but none provided
  return verifyPassword(pw, srv.password);
}

function setPassword(serverName, userId, newPw) {
  const srv = servers[serverName];
  if (!srv) return null;
  if (srv.creator !== userId) return false;
  srv.password = newPw ? hashPassword(newPw) : null;
  return !!srv.password;
}

// ── Client tracking ─────────────────────────────────────────────────────────

function registerClient(ws, info) {
  clients.set(ws, info);
}

function unregisterClient(ws) {
  const info = clients.get(ws);
  clients.delete(ws);
  return info;
}

function getClient(ws) {
  return clients.get(ws) || null;
}

function getClientByUserId(serverName, userId) {
  for (const [ws, client] of clients) {
    if (client.serverName === serverName && client.userId === userId) return { ws, client };
  }
  return null;
}

function getActiveConnections() {
  return clients.size;
}

// ── State snapshot ──────────────────────────────────────────────────────────

function buildServerState(serverName) {
  const srv = servers[serverName];
  if (!srv) return null;
  const channels = {};
  for (const [cname, ch] of Object.entries(srv.channels)) {
    channels[cname] = {
      name: ch.name,
      users: Object.fromEntries(
        Object.entries(ch.users).map(([uid, u]) => [uid, { userId: uid, username: u.username }])
      )
    };
  }
  const users = {};
  for (const [uid, u] of Object.entries(srv.users)) {
    users[uid] = { userId: uid, username: u.username, channelName: u.channelName, isMuted: u.isMuted || false, isDeafened: u.isDeafened || false, avatar: u.avatar || null };
  }
  return {
    type: 'server-state',
    serverName: srv.name,
    creator: srv.creator,
    hasPassword: !!srv.password,
    channels,
    users,
    yourUserId: null
  };
}

// ── Is creator? ─────────────────────────────────────────────────────────────

function isCreator(serverName, userId) {
  return servers[serverName]?.creator === userId;
}

module.exports = {
  send, broadcastToServer, broadcastToChannel, broadcastToChannelBinary,
  getChannelUserCount,
  createServer, getServer, serverExists, serverCount,
  nextId,
  addUser, removeUser, getUser, changeUsername,
  joinChannel, leaveChannel, addChannel, getChannelPeers, recalculateMixer,
  checkPassword, setPassword,
  registerClient, unregisterClient, getClient, getClientByUserId,
  buildServerState, getActiveConnections,
  isCreator,
  hashPassword, verifyPassword, validateString,
  scheduleDisconnect, cancelDisconnect, isUserInGrace,
  reconnectUser, getReconnectToken,
  DISCONNECT_GRACE_MS,
  LIMITS
};
