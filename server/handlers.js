// ── WebSocket message handlers ──────────────────────────────────────────────
// Each handler receives the raw parsed message and the WebSocket.
// State and broadcasting are accessed via the state module.

const state = require('./state');

// ── Input validation helper ─────────────────────────────────────────────────

function validate(value, maxLen) {
  return state.validateString(value, maxLen);
}

// ── Rate limiting (per-connection) ──────────────────────────────────────────

const rateLimiters = new Map(); // ws -> { timestamps: [] }

const MSG_RATE_WINDOW = 1000;   // 1 second sliding window
const MSG_RATE_MAX   = 30;      // max messages per window

function checkRateLimit(ws) {
  const now = Date.now();
  let entry = rateLimiters.get(ws);
  if (!entry) {
    entry = { timestamps: [] };
    rateLimiters.set(ws, entry);
  }
  // Remove expired timestamps
  while (entry.timestamps.length > 0 && entry.timestamps[0] < now - MSG_RATE_WINDOW) {
    entry.timestamps.shift();
  }
  if (entry.timestamps.length >= MSG_RATE_MAX) {
    return false; // rate limited
  }
  entry.timestamps.push(now);
  return true;
}

function cleanupRateLimit(ws) {
  rateLimiters.delete(ws);
}

// ── join-server ─────────────────────────────────────────────────────────────
function handleJoinServer(ws, msg) {
  const serverName = validate(msg.serverName, state.LIMITS.SERVER_NAME_MAX);
  const username = validate(msg.username, state.LIMITS.USERNAME_MAX) || 'User';
  const password = msg.password ? validate(msg.password, state.LIMITS.PASSWORD_MAX) : null;

  if (!serverName) {
    state.send(ws, { type: 'error', message: 'Server name required' });
    return {};
  }

  // Check password for existing server
  if (state.serverExists(serverName)) {
    if (!state.checkPassword(serverName, password)) {
      state.send(ws, { type: 'password-required', serverName });
      return {};
    }
  }

  // Enforce server cap
  if (!state.serverExists(serverName) && state.serverCount() >= state.LIMITS.MAX_SERVERS) {
    state.send(ws, { type: 'error', message: 'Server limit reached. Try again later.' });
    return {};
  }

  const userId = state.nextId();

  // Create if new
  if (!state.serverExists(serverName)) {
    state.createServer(serverName, userId, password || null);
  }

  // Enforce per-server user cap
  const srv = state.getServer(serverName);
  if (srv && Object.keys(srv.users).length >= state.LIMITS.MAX_USERS_PER_SERVER) {
    state.send(ws, { type: 'error', message: 'Server is full.' });
    return {};
  }

  const avatar = (typeof msg.avatar === 'string' && msg.avatar.startsWith('data:image/') && msg.avatar.length < 200000) ? msg.avatar : null;

  state.addUser(serverName, userId, username, avatar);
  state.registerClient(ws, { ws, userId, username, serverName });

  // Send full state with reconnect token
  const s = state.buildServerState(serverName);
  s.yourUserId = userId;
  s.reconnectToken = state.getReconnectToken(serverName, userId);
  state.send(ws, s);

  // Broadcast to others
  state.broadcastToServer(serverName, {
    type: 'user-joined-server',
    userId,
    username,
    channelName: null,
    avatar
  }, ws);

  console.log(`[+] ${username} (${userId}) joined server "${serverName}"`);
  return { userId, username, serverName };
}

// ── join-channel ────────────────────────────────────────────────────────────
function handleJoinChannel(ws, msg, context) {
  const { userId, username, serverName } = context;
  const channelName = validate(msg.channelName, state.LIMITS.CHANNEL_NAME_MAX);

  if (!serverName || !userId) {
    state.send(ws, { type: 'error', message: 'Not in a server' });
    return;
  }

  if (!channelName) {
    state.send(ws, { type: 'error', message: 'Invalid channel name' });
    return;
  }

  const srv = state.getServer(serverName);
  if (!srv?.channels[channelName]) {
    state.send(ws, { type: 'error', message: 'Channel not found' });
    return;
  }

  const result = state.joinChannel(serverName, userId, channelName);
  if (!result) return;

  const peers = state.getChannelPeers(serverName, channelName, userId);

  // Tell joiner about existing peers
  const mixerId = state.recalculateMixer(serverName, channelName);
  const totalUsers = state.getChannelUserCount(serverName, channelName);
  state.send(ws, {
    type: 'joined-channel',
    channelName,
    existingPeers: peers,
    mixerId,
    totalUsers,
    peerDetails: peers.map(id => ({
      userId: id,
      username: srv.channels[channelName].users[id].username
    }))
  });

  // Tell existing peers to initiate WebRTC
  const mixerAfter = state.recalculateMixer(serverName, channelName);
  const totalAfter = state.getChannelUserCount(serverName, channelName);
  const newUser = srv.users[userId];
  state.broadcastToChannel(serverName, channelName, {
    type: 'peer-joined-channel',
    userId,
    username,
    channelName,
    mixerId: mixerAfter,
    totalUsers: totalAfter,
    isMuted: newUser?.isMuted || false,
    isDeafened: newUser?.isDeafened || false
  }, ws);

  // If mixer changed, tell everyone
  state.broadcastToChannel(serverName, channelName, {
    type: 'mixer-changed', mixerId: mixerAfter
  });

  // Update everyone's user list
  const updatedUser = state.getUser(serverName, userId);
  state.broadcastToServer(serverName, {
    type: 'user-channel-update',
    userId,
    username,
    channelName,
    avatar: updatedUser?.avatar || null
  });

  console.log(`[→] ${username} joined channel "${channelName}" in "${serverName}"`);
}

// ── leave-channel ───────────────────────────────────────────────────────────
function handleLeaveChannel(ws, msg, context) {
  const { userId, username, serverName } = context;
  if (!serverName || !userId) return;

  const user = state.getUser(serverName, userId);
  if (!user?.channelName) return;

  const oldChannel = state.leaveChannel(serverName, userId);
  if (!oldChannel) return;

  // Tell others in the channel
  state.broadcastToChannel(serverName, oldChannel, {
    type: 'peer-left-channel',
    userId,
    username,
    channelName: oldChannel
  });

  // Tell the leaver
  state.send(ws, { type: 'left-channel', channelName: oldChannel });

  // Recalculate and broadcast mixer
  const newMixer = state.recalculateMixer(serverName, oldChannel);
  state.broadcastToChannel(serverName, oldChannel, {
    type: 'mixer-changed', mixerId: newMixer
  });

  state.broadcastToServer(serverName, {
    type: 'user-channel-update',
    userId,
    username,
    channelName: null
  });

  console.log(`[←] ${username} left channel "${oldChannel}" in "${serverName}"`);
}

// ── add-channel (creator only) ──────────────────────────────────────────────
function handleAddChannel(ws, msg, context) {
  const { userId, username, serverName } = context;
  if (!serverName) return;

  if (!state.isCreator(serverName, userId)) {
    state.send(ws, { type: 'error', message: 'Only the server creator can add channels' });
    return;
  }

  const name = validate(msg.channelName, state.LIMITS.CHANNEL_NAME_MAX);
  if (!name) {
    state.send(ws, { type: 'error', message: 'Channel name required' });
    return;
  }

  const key = state.addChannel(serverName, name);
  if (!key) {
    state.send(ws, { type: 'error', message: 'Channel already exists' });
    return;
  }

  state.broadcastToServer(serverName, {
    type: 'channel-added',
    channelKey: key,
    channelName: name
  });

  console.log(`[+] Channel "${name}" added to "${serverName}" by ${username}`);
}

// ── change-username ─────────────────────────────────────────────────────────
function handleChangeUsername(ws, msg, context) {
  const { userId, serverName } = context;
  if (!serverName || !userId) return;

  const newName = validate(msg.username, state.LIMITS.USERNAME_MAX);
  if (!newName) return;

  const result = state.changeUsername(serverName, userId, newName);
  if (!result) return;

  state.broadcastToServer(serverName, {
    type: 'user-renamed',
    userId,
    oldUsername: result.old,
    newUsername: result.new
  });

  console.log(`[✏️] ${result.old} renamed to ${result.new} in "${serverName}"`);
}

// ── set-password (creator only) ─────────────────────────────────────────────
function handleSetPassword(ws, msg, context) {
  const { userId, username, serverName } = context;
  if (!serverName) return;

  const password = msg.password ? validate(msg.password, state.LIMITS.PASSWORD_MAX) : null;

  const result = state.setPassword(serverName, userId, password || null);
  if (result === false) {
    state.send(ws, { type: 'error', message: 'Only the server creator can change the password' });
    return;
  }

  state.broadcastToServer(serverName, {
    type: 'password-updated',
    hasPassword: result
  });

  console.log(`[🔒] Password ${result ? 'set' : 'removed'} for "${serverName}" by ${username}`);
}

// ── chat-message ────────────────────────────────────────────────────────────
function handleChatMessage(ws, msg, context) {
  const { userId, serverName } = context;
  if (!serverName || !userId) return;

  const user = state.getUser(serverName, userId);
  if (!user?.channelName) return;

  const text = validate(msg.message, state.LIMITS.CHAT_MESSAGE_MAX);
  if (!text) return;

  state.broadcastToChannel(serverName, user.channelName, {
    type: 'chat-message',
    userId,
    username: user.username,
    message: text,
    timestamp: Date.now()
  });
}

// ── WebRTC signaling relay ──────────────────────────────────────────────────
function handleWebRTCSignal(ws, msg, context) {
  const { userId, username, serverName } = context;
  const target = state.getClientByUserId(serverName, msg.targetId);
  if (!target) return;

  // Verify both users are in the same channel
  const senderUser = state.getUser(serverName, userId);
  const targetUser = state.getUser(serverName, msg.targetId);
  if (!senderUser?.channelName || senderUser.channelName !== targetUser?.channelName) {
    return; // silently drop cross-channel signaling
  }

  state.send(target.ws, {
    type: msg.type,
    fromId: userId,
    fromUsername: username,
    offer: msg.offer,
    answer: msg.answer,
    candidate: msg.candidate
  });
}

// ── reconnect-session (called when client auto-reconnects with a token) ─────
function handleReconnectSession(ws, msg) {
  const serverName = state.validateString(msg.serverName, state.LIMITS.SERVER_NAME_MAX);
  const userId = msg.userId;
  const token = msg.reconnectToken;

  if (!serverName || !userId || !token) {
    state.send(ws, { type: 'error', message: 'Invalid reconnect request' });
    return {};
  }

  // Verify token matches
  const expectedToken = state.getReconnectToken(serverName, userId);
  if (token !== expectedToken) {
    state.send(ws, { type: 'error', message: 'Invalid reconnect token' });
    return {};
  }

  // Check if user is in grace period
  if (!state.isUserInGrace(serverName, userId)) {
    state.send(ws, { type: 'error', message: 'Session expired, please rejoin' });
    return {};
  }

  // Reconnect!
  const user = state.reconnectUser(serverName, userId, ws);
  if (!user) {
    state.send(ws, { type: 'error', message: 'Reconnect failed' });
    return {};
  }

  // Send full state
  const s = state.buildServerState(serverName);
  s.yourUserId = userId;
  s.reconnectToken = token;
  s.reconnected = true;  // client flag to skip re-init
  state.send(ws, s);

  // If user was in a channel, tell peers they're back
  if (user.channelName) {
    const totalUsers = state.getChannelUserCount(serverName, user.channelName);
    const mixerId = state.recalculateMixer(serverName, user.channelName);
    state.broadcastToChannel(serverName, user.channelName, {
      type: 'peer-joined-channel',
      userId,
      username: user.username,
      channelName: user.channelName,
      mixerId,
      totalUsers,
      isMuted: user.isMuted || false,
      isDeafened: user.isDeafened || false
    }, ws);
    state.broadcastToChannel(serverName, user.channelName, {
      type: 'mixer-changed', mixerId
    });
  }

  console.log(`[🔄] ${user.username} reconnected successfully to "${serverName}"`);
  return { userId, username: user.username, serverName };
}

// ── Disconnect cleanup ──────────────────────────────────────────────────────
function handleDisconnect(ws) {
  cleanupRateLimit(ws);

  const client = state.unregisterClient(ws);
  if (!client) return null;

  const { userId, username, serverName } = client;

  if (serverName && userId) {
    // Check if user still exists (they might have been removed by a 'disconnect' msg)
    if (state.getUser(serverName, userId)) {
      // Don't remove immediately — start grace period for mobile users
      state.scheduleDisconnect(serverName, userId, ws);
      console.log(`[-] ${username || 'unknown'} disconnected (grace period started)`);
    } else {
      console.log(`[-] ${username || 'unknown'} disconnected (already removed)`);
    }
  } else {
    console.log(`[-] ${username || 'unknown'} disconnected`);
  }
  return client;
}

// ── Client state broadcast (mute/deafen status) ─────────────────────────────

function broadcastClientState(ws, msg, context, msgType) {
  const { userId, serverName } = context;
  if (!serverName || !userId) return;

  const user = state.getUser(serverName, userId);
  if (!user?.channelName) return;

  // Persist state on server (survives reloads)
  if (msgType === 'mute-state-changed') user.isMuted = !!msg.value;
  if (msgType === 'deafen-state-changed') user.isDeafened = !!msg.value;

  state.broadcastToChannel(serverName, user.channelName, {
    type: msgType,
    userId,
    username: user.username,
    value: msg.value
  }, ws);
}

// ── File announce relay ────────────────────────────────────────────────────

function handleFileAnnounce(ws, msg, context) {
  const { userId, serverName } = context;
  if (!serverName || !userId) return;

  const user = state.getUser(serverName, userId);
  if (!user?.channelName) return;

  // Validate file metadata
  const fileName = validate(msg.fileName, state.LIMITS.FILE_NAME_MAX);
  if (!fileName) return;

  state.broadcastToChannel(serverName, user.channelName, {
    type: 'file-announce',
    userId,
    username: user.username,
    fileId: msg.fileId,
    fileName,
    fileSize: typeof msg.fileSize === 'number' ? msg.fileSize : 0,
    fileType: msg.fileType
  }, ws);
}

// ── Avatar change relay ────────────────────────────────────────────────────

function handleAvatarChanged(ws, msg, context) {
  const { userId, serverName } = context;
  if (!serverName || !userId) return;

  const user = state.getUser(serverName, userId);
  if (!user) return;

  // Validate: string data URL or null to remove
  const avatar = (typeof msg.avatar === 'string' && msg.avatar.startsWith('data:image/') && msg.avatar.length < 200000) ? msg.avatar : null;
  user.avatar = avatar;

  state.broadcastToServer(serverName, {
    type: 'avatar-changed',
    userId,
    avatar
  });
}

// ── Video state relay ──────────────────────────────────────────────────────

function handleVideoStateChanged(ws, msg, context) {
  const { userId, serverName } = context;
  if (!serverName || !userId) return;

  const user = state.getUser(serverName, userId);
  if (!user?.channelName) return;

  state.broadcastToChannel(serverName, user.channelName, {
    type: 'video-state-changed',
    userId,
    active: !!msg.active,
    source: msg.source || 'camera'
  }, ws);
}

// ── Route message to handler ────────────────────────────────────────────────
function route(ws, msg, context) {
  // Per-connection rate limiting
  if (!checkRateLimit(ws)) {
    console.warn('Rate limit exceeded for connection');
    return;
  }

  switch (msg.type) {
    case 'join-server':       return handleJoinServer(ws, msg);
    case 'reconnect-session': return handleReconnectSession(ws, msg);
    case 'join-channel':      return handleJoinChannel(ws, msg, context);
    case 'leave-channel':     return handleLeaveChannel(ws, msg, context);
    case 'add-channel':       return handleAddChannel(ws, msg, context);
    case 'change-username':   return handleChangeUsername(ws, msg, context);
    case 'set-password':      return handleSetPassword(ws, msg, context);
    case 'chat-message':      return handleChatMessage(ws, msg, context);
    case 'file-announce':     return handleFileAnnounce(ws, msg, context);
    case 'avatar-changed':     return handleAvatarChanged(ws, msg, context);
    case 'video-state-changed': return handleVideoStateChanged(ws, msg, context);
    case 'mute-state-changed':
    case 'deafen-state-changed': return broadcastClientState(ws, msg, context, msg.type);
    case 'webrtc-offer':
    case 'webrtc-answer':
    case 'webrtc-ice-candidate': return handleWebRTCSignal(ws, msg, context);
    case 'disconnect': {
      // Client is intentionally leaving — immediately remove (no grace period)
      const { userId, serverName } = context;
      if (serverName && userId) {
        state.cancelDisconnect(serverName, userId);
        // Notify peers before removing
        const user = state.getUser(serverName, userId);
        if (user?.channelName) {
          state.broadcastToChannel(serverName, user.channelName, {
            type: 'peer-left-channel',
            userId, username: user.username, channelName: user.channelName
          });
          const newMixer = state.recalculateMixer(serverName, user.channelName);
          state.broadcastToChannel(serverName, user.channelName, {
            type: 'mixer-changed', mixerId: newMixer
          });
        }
        state.broadcastToServer(serverName, {
          type: 'user-left-server', userId, username: user?.username || context.username
        });
        state.removeUser(serverName, userId);
        console.log(`[👋] ${context.username || userId} intentionally left "${serverName}"`);
      }
      break;
    }
    case 'ping': break;  // keep-alive, no-op
    default:
      console.log('Unknown message type:', msg.type);
  }
}

module.exports = { route, handleDisconnect };
