const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/server/:name', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── State ────────────────────────────────────────────────────────────────────
const servers = {};  // serverName -> { name, creator, password|null, channels: { [name]: { users: { userId: { userId, username } } } }, users: { userId: { username, channelName|null } } }

let nextUserId = 1;
const clients = new Map();  // ws -> { ws, userId, username, serverName }

// ── Helpers ──────────────────────────────────────────────────────────────────

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcastToServer(serverName, msg, excludeWs = null) {
  for (const [ws, client] of clients) {
    if (client.serverName === serverName && ws !== excludeWs) {
      send(ws, msg);
    }
  }
}

function broadcastToChannel(serverName, channelName, msg, excludeWs = null) {
  const server = servers[serverName];
  if (!server || !server.channels[channelName]) return;
  const channelUsers = server.channels[channelName].users;
  for (const [ws, client] of clients) {
    if (client.serverName === serverName && channelUsers[client.userId] && ws !== excludeWs) {
      send(ws, msg);
    }
  }
}

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
    users[uid] = { userId: uid, username: u.username, channelName: u.channelName };
  }
  return {
    type: 'server-state',
    serverName: srv.name,
    creator: srv.creator,
    hasPassword: !!srv.password,
    channels,
    users,
    yourUserId: null  // filled in per-client below
  };
}

function removeUserFromChannel(serverName, userId, ws) {
  const srv = servers[serverName];
  const user = srv?.users[userId];
  if (!user || !user.channelName) return;

  const oldChannel = user.channelName;
  const channel = srv.channels[oldChannel];
  if (channel) {
    delete channel.users[userId];
    user.channelName = null;

    // Notify remaining channel members
    broadcastToChannel(serverName, oldChannel, {
      type: 'peer-left-channel',
      userId,
      username: user.username,
      channelName: oldChannel
    });

    // Clean up empty channel? No — keep default channels.
  }
}

// ── WebSocket handling ───────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  let userId = null;
  let username = null;
  let serverName = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    switch (msg.type) {

      // ── join-server ──────────────────────────────────────────────────
      case 'join-server': {
        serverName = msg.serverName?.trim();
        username = msg.username?.trim() || 'User';
        if (!serverName) {
          send(ws, { type: 'error', message: 'Server name required' });
          return;
        }

        // Check password for existing server
        if (servers[serverName]) {
          if (servers[serverName].password && servers[serverName].password !== msg.password) {
            send(ws, { type: 'password-required', serverName });
            return;
          }
          userId = String(nextUserId++);
        } else {
          // Create server with optional password
          userId = String(nextUserId++);
          servers[serverName] = {
            name: serverName,
            creator: userId,
            password: msg.password || null,
            channels: {
              'lobby':     { name: 'Lobby',     users: {} },
              'channel 1': { name: 'Channel 1', users: {} },
              'channel 2': { name: 'Channel 2', users: {} }
            },
            users: {}
          };
        }

        servers[serverName].users[userId] = { username, channelName: null };
        clients.set(ws, { ws, userId, username, serverName });

        // Send full state to the new user
        const state = buildServerState(serverName);
        state.yourUserId = userId;
        send(ws, state);

        // Notify other users in server
        broadcastToServer(serverName, {
          type: 'user-joined-server',
          userId,
          username,
          channelName: null
        }, ws);

        console.log(`[+] ${username} (${userId}) joined server "${serverName}"`);
        break;
      }

      // ── join-channel ─────────────────────────────────────────────────
      case 'join-channel': {
        const srv = servers[serverName];
        if (!srv || !userId) {
          send(ws, { type: 'error', message: 'Not in a server' });
          return;
        }

        const channelName = msg.channelName;
        const channel = srv.channels[channelName];
        if (!channel) {
          send(ws, { type: 'error', message: 'Channel not found' });
          return;
        }

        const user = srv.users[userId];
        if (!user) return;

        // Leave current channel first
        if (user.channelName) {
          removeUserFromChannel(serverName, userId, ws);
        }

        // Join new channel
        user.channelName = channelName;
        channel.users[userId] = { userId, username };

        // Get list of existing peers in channel (excluding self)
        const existingPeers = Object.keys(channel.users).filter(id => id !== userId);

        // Tell the joiner about existing peers (who will send them offers)
        send(ws, {
          type: 'joined-channel',
          channelName,
          existingPeers,
          peerDetails: existingPeers.map(id => ({
            userId: id,
            username: channel.users[id].username
          }))
        });

        // Tell existing peers to initiate connections to the new user
        broadcastToChannel(serverName, channelName, {
          type: 'peer-joined-channel',
          userId,
          username,
          channelName
        }, ws);

        // Broadcast updated server state to all (for user counts, etc.)
        broadcastToServer(serverName, {
          type: 'user-channel-update',
          userId,
          username,
          channelName
        });

        console.log(`[→] ${username} joined channel "${channelName}" in "${serverName}"`);
        break;
      }

      // ── leave-channel ────────────────────────────────────────────────
      case 'leave-channel': {
        if (!serverName || !userId) break;
        const srv = servers[serverName];
        if (!srv) break;

        const user = srv.users[userId];
        if (!user?.channelName) break;

        const oldChannelName = user.channelName;
        removeUserFromChannel(serverName, userId, ws);

        // Tell the leaving user to close all peer connections
        send(ws, { type: 'left-channel', channelName: oldChannelName });

        broadcastToServer(serverName, {
          type: 'user-channel-update',
          userId,
          username,
          channelName: null
        });

        console.log(`[←] ${username} left channel "${oldChannelName}" in "${serverName}"`);
        break;
      }

      // ── add-channel (creator only) ───────────────────────────────────
      case 'add-channel': {
        const srv = servers[serverName];
        if (!srv) break;

        if (srv.creator !== userId) {
          send(ws, { type: 'error', message: 'Only the server creator can add channels' });
          break;
        }

        const newChannelName = msg.channelName?.trim();
        if (!newChannelName) {
          send(ws, { type: 'error', message: 'Channel name required' });
          break;
        }

        // Use a normalized key (lowercase, no spaces) internally
        const key = newChannelName.toLowerCase().replace(/\s+/g, '-');
        if (srv.channels[key] || srv.channels[newChannelName]) {
          send(ws, { type: 'error', message: 'Channel already exists' });
          break;
        }

        srv.channels[key] = { name: newChannelName, users: {} };

        broadcastToServer(serverName, {
          type: 'channel-added',
          channelKey: key,
          channelName: newChannelName
        });

        console.log(`[+] Channel "${newChannelName}" added to "${serverName}" by ${username}`);
        break;
      }

      // ── change-username ──────────────────────────────────────────────
      case 'change-username': {
        const srv = servers[serverName];
        if (!srv || !userId) break;
        const newName = msg.username?.trim();
        if (!newName) break;
        const user = srv.users[userId];
        if (!user) break;
        const oldName = user.username;
        user.username = newName;
        if (user.channelName && srv.channels[user.channelName]) {
          const chUser = srv.channels[user.channelName].users[userId];
          if (chUser) chUser.username = newName;
        }
        broadcastToServer(serverName, {
          type: 'user-renamed',
          userId,
          oldUsername: oldName,
          newUsername: newName
        });
        console.log(`[✏️] ${oldName} renamed to ${newName} in "${serverName}"`);
        break;
      }

      // ── set-password (creator only) ──────────────────────────────────
      case 'set-password': {
        const srv = servers[serverName];
        if (!srv) break;
        if (srv.creator !== userId) {
          send(ws, { type: 'error', message: 'Only the server creator can change the password' });
          break;
        }
        const newPw = msg.password || null;
        srv.password = newPw || null;
        broadcastToServer(serverName, {
          type: 'password-updated',
          hasPassword: !!srv.password
        });
        console.log(`[🔒] Password ${srv.password ? 'set' : 'removed'} for "${serverName}" by ${username}`);
        break;
      }

      // ── chat-message ────────────────────────────────────────────────
      case 'chat-message': {
        if (!serverName || !userId) break;
        const srv = servers[serverName];
        if (!srv) break;
        const user = srv.users[userId];
        if (!user || !user.channelName) break;
        const text = msg.message?.trim();
        if (!text) break;
        broadcastToChannel(serverName, user.channelName, {
          type: 'chat-message',
          userId,
          username: user.username,
          message: text,
          timestamp: Date.now()
        });
        break;
      }

      // ── WebRTC signaling relay ───────────────────────────────────────
      case 'webrtc-offer':
      case 'webrtc-answer':
      case 'webrtc-ice-candidate': {
        const targetId = msg.targetId;
        // Find target's WebSocket
        for (const [clientWs, client] of clients) {
          if (client.userId === targetId && client.serverName === serverName) {
            send(clientWs, {
              type: msg.type,
              fromId: userId,
              fromUsername: username,
              offer: msg.offer,
              answer: msg.answer,
              candidate: msg.candidate
            });
            break;
          }
        }
        break;
      }

      default:
        console.log('Unknown message type:', msg.type);
    }
  });

  ws.on('close', () => {
    console.log(`[-] ${username || 'unknown'} disconnected`);

    if (serverName && userId && servers[serverName]) {
      const srv = servers[serverName];
      const user = srv.users[userId];
      if (user) {
        // Remove from channel
        if (user.channelName) {
          const ch = srv.channels[user.channelName];
          if (ch) {
            delete ch.users[userId];
            broadcastToChannel(serverName, user.channelName, {
              type: 'peer-left-channel',
              userId,
              username: user.username,
              channelName: user.channelName
            });
          }
        }
        delete srv.users[userId];
      }

      // Notify remaining users
      broadcastToServer(serverName, {
        type: 'user-left-server',
        userId,
        username: user?.username || username
      });

      // Clean up empty server (optional: keep it)
      if (Object.keys(srv.users).length === 0) {
        // Keep server for now — creator might rejoin
      }
    }

    clients.delete(ws);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎤 ezspeak running on http://localhost:${PORT}`);
  console.log(`   Join a server: http://localhost:${PORT}/server/myserver`);
  console.log(`   Firefox? Try:    http://127.0.0.1:${PORT}/server/myserver`);
});
