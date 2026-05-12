// ── In-memory server state ──────────────────────────────────────────────────
// All servers, channels, users, and client connections live here.
// No database — servers persist as long as at least one user is connected.

const WebSocket = require('ws');

const servers = {};  // serverName -> { name, creator, password|null, channels, users }
let nextUserId = 1;
const clients = new Map();  // ws -> { ws, userId, username, serverName }

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
    password: password || null,
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

// ── User management ─────────────────────────────────────────────────────────

function nextId() {
  return String(nextUserId++);
}

function addUser(serverName, userId, username) {
  const srv = servers[serverName];
  if (!srv) return null;
  srv.users[userId] = { username, channelName: null, isMuted: false, isDeafened: false };
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
  if (!srv) return true;
  if (!srv.password) return true;
  return srv.password === pw;
}

function setPassword(serverName, userId, newPw) {
  const srv = servers[serverName];
  if (!srv) return null;
  if (srv.creator !== userId) return false;
  srv.password = newPw || null;
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
    users[uid] = { userId: uid, username: u.username, channelName: u.channelName, isMuted: u.isMuted || false, isDeafened: u.isDeafened || false };
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
  createServer, getServer, serverExists,
  nextId,
  addUser, removeUser, getUser, changeUsername,
  joinChannel, leaveChannel, addChannel, getChannelPeers, recalculateMixer,
  checkPassword, setPassword,
  registerClient, unregisterClient, getClient, getClientByUserId,
  buildServerState,
  isCreator
};
