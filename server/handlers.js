// ── WebSocket message handlers ──────────────────────────────────────────────
// Each handler receives the raw parsed message and the WebSocket.
// State and broadcasting are accessed via the state module.

const state = require('./state');

// ── join-server ─────────────────────────────────────────────────────────────
function handleJoinServer(ws, msg) {
  const serverName = msg.serverName?.trim();
  const username = msg.username?.trim() || 'User';
  if (!serverName) {
    state.send(ws, { type: 'error', message: 'Server name required' });
    return {};
  }

  // Check password for existing server
  if (state.serverExists(serverName)) {
    if (!state.checkPassword(serverName, msg.password)) {
      state.send(ws, { type: 'password-required', serverName });
      return {};
    }
  }

  const userId = state.nextId();

  // Create if new
  if (!state.serverExists(serverName)) {
    state.createServer(serverName, userId, msg.password || null);
  }

  state.addUser(serverName, userId, username);
  state.registerClient(ws, { ws, userId, username, serverName });

  // Send full state
  const s = state.buildServerState(serverName);
  s.yourUserId = userId;
  state.send(ws, s);

  // Broadcast to others
  state.broadcastToServer(serverName, {
    type: 'user-joined-server',
    userId,
    username,
    channelName: null
  }, ws);

  console.log(`[+] ${username} (${userId}) joined server "${serverName}"`);
  return { userId, username, serverName };
}

// ── join-channel ────────────────────────────────────────────────────────────
function handleJoinChannel(ws, msg, context) {
  const { userId, username, serverName } = context;
  const channelName = msg.channelName;

  if (!serverName || !userId) {
    state.send(ws, { type: 'error', message: 'Not in a server' });
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
  state.send(ws, {
    type: 'joined-channel',
    channelName,
    existingPeers: peers,
    peerDetails: peers.map(id => ({
      userId: id,
      username: srv.channels[channelName].users[id].username
    }))
  });

  // Tell existing peers to initiate WebRTC
  state.broadcastToChannel(serverName, channelName, {
    type: 'peer-joined-channel',
    userId,
    username,
    channelName
  }, ws);

  // Update everyone's user list
  state.broadcastToServer(serverName, {
    type: 'user-channel-update',
    userId,
    username,
    channelName
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

  const name = msg.channelName?.trim();
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

  const newName = msg.username?.trim();
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

  const result = state.setPassword(serverName, userId, msg.password || null);
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

  const text = msg.message?.trim();
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

  state.send(target.ws, {
    type: msg.type,
    fromId: userId,
    fromUsername: username,
    offer: msg.offer,
    answer: msg.answer,
    candidate: msg.candidate
  });
}

// ── Disconnect cleanup ──────────────────────────────────────────────────────
function handleDisconnect(ws) {
  const client = state.unregisterClient(ws);
  if (!client) return null;

  const { userId, username, serverName } = client;

  if (serverName && userId) {
    const user = state.removeUser(serverName, userId);
    if (user?.channelName) {
      state.broadcastToChannel(serverName, user.channelName, {
        type: 'peer-left-channel',
        userId,
        username,
        channelName: user.channelName
      });
    }

    state.broadcastToServer(serverName, {
      type: 'user-left-server',
      userId,
      username
    });
  }

  console.log(`[-] ${username || 'unknown'} disconnected`);
  return client;
}

// ── Route message to handler ────────────────────────────────────────────────
function route(ws, msg, context) {
  switch (msg.type) {
    case 'join-server':       return handleJoinServer(ws, msg);
    case 'join-channel':      return handleJoinChannel(ws, msg, context);
    case 'leave-channel':     return handleLeaveChannel(ws, msg, context);
    case 'add-channel':       return handleAddChannel(ws, msg, context);
    case 'change-username':   return handleChangeUsername(ws, msg, context);
    case 'set-password':      return handleSetPassword(ws, msg, context);
    case 'chat-message':      return handleChatMessage(ws, msg, context);
    case 'webrtc-offer':
    case 'webrtc-answer':
    case 'webrtc-ice-candidate': return handleWebRTCSignal(ws, msg, context);
    default:
      console.log('Unknown message type:', msg.type);
  }
}

module.exports = { route, handleDisconnect };
