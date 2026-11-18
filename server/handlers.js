// ── WebSocket message handlers ──────────────────────────────────────────────
// createHandlers(state, config) returns { onConnection-level hooks }.
// Every handler resolves the acting user from the socket itself, so there
// is no per-connection "context" object that could get out of sync.

const { validateString, validateAvatar, safeEqual } = require('./state');
const { buildIceServers } = require('./ice');
const { stripNonRelayFromSdp, sanitizeCandidate, normalizeServerName } = require('../public/js/shared');

// ── Token-bucket rate limiting ──────────────────────────────────────────────
// Signaling (offers/answers/ICE) comes in bursts when joining a busy
// channel, so it gets its own, much larger bucket than chat & friends.

const BUCKETS = {
  general: { capacity: 20, refillPerSec: 10 },
  signal:  { capacity: 400, refillPerSec: 100 },
};
const SIGNAL_TYPES = new Set(['webrtc-offer', 'webrtc-answer', 'webrtc-ice-candidate', 'ping']);

function takeToken(buckets, kind, now = Date.now()) {
  const spec = BUCKETS[kind];
  let b = buckets[kind];
  if (!b) b = buckets[kind] = { tokens: spec.capacity, last: now };
  b.tokens = Math.min(spec.capacity, b.tokens + ((now - b.last) / 1000) * spec.refillPerSec);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function createHandlers(state, config, log = console) {
  const L = config.limits;
  const rate = new WeakMap(); // ws → buckets

  function error(ws, code, message) {
    state.send(ws, { type: 'error', code, message });
  }

  function isCreator(srv, user) {
    return !!srv && !!user && srv.creatorId === user.id;
  }

  function current(ws) {
    const user = state.userForSocket(ws);
    if (!user) return { user: null, srv: null };
    const srv = state.getServer(user.serverName);
    if (!srv || srv.users.get(user.id) !== user) return { user: null, srv: null };
    return { user, srv };
  }

  function iceServersFor(user) {
    return buildIceServers(config.ice, user.id);
  }

  function sendServerState(ws, srv, user, extra = {}) {
    const s = state.buildServerState(srv);
    s.yourUserId = user.id;
    s.reconnectToken = user.token;
    s.iceServers = iceServersFor(user);
    Object.assign(s, extra);
    state.send(ws, s);
  }

  // ── Leave / removal helpers ──────────────────────────────────────────────

  function announceChannelLeave(srv, user, channelKey) {
    state.broadcastToChannel(srv, channelKey, {
      type: 'peer-left-channel', userId: user.id, username: user.username, channelName: channelKey,
    }, user.id);
  }

  function removeUserAndNotify(user, reason) {
    const { srv, channelKey, serverDeleted } = state.removeUser(user);
    if (!srv) return;
    if (serverDeleted) {
      log.log(`[🧹] Server "${srv.name}" removed (no users left)`);
      return;
    }
    if (channelKey) announceChannelLeave(srv, user, channelKey);
    state.broadcastToServer(srv, { type: 'user-left-server', userId: user.id, username: user.username });
    if (srv.creatorId === user.id) {
      // Hand server management over to the longest-present user.
      const next = srv.users.values().next().value;
      srv.creatorId = next ? next.id : null;
      if (next) state.broadcastToServer(srv, { type: 'creator-changed', creator: next.id });
    }
    log.log(`[-] ${user.username} (${user.id}) left "${srv.name}" (${reason})`);
  }

  function startGrace(user) {
    if (user.graceTimer) clearTimeout(user.graceTimer);
    if (config.disconnectGraceMs <= 0) return removeUserAndNotify(user, 'disconnected');
    user.graceTimer = setTimeout(() => {
      user.graceTimer = null;
      if (!user.ws) removeUserAndNotify(user, 'grace period expired');
    }, config.disconnectGraceMs);
    if (user.graceTimer.unref) user.graceTimer.unref();
  }

  // ── join-server ──────────────────────────────────────────────────────────
  function handleJoinServer(ws, msg) {
    if (state.userForSocket(ws)) return error(ws, 'ALREADY_JOINED', 'Already joined a server on this connection');

    const serverName = validateString(normalizeServerName(msg.serverName), L.serverNameMax);
    if (!serverName) return error(ws, 'INVALID_SERVER_NAME', 'Server name required');
    const username = validateString(msg.username, L.usernameMax) || 'User';
    const password = typeof msg.password === 'string' && msg.password
      ? validateString(msg.password, L.passwordMax) : null;
    const avatar = validateAvatar(msg.avatar, L.avatarMax);
    const ip = state.socketInfo(ws)?.ip || null;

    let srv = state.getServer(serverName);
    let created = false;
    if (srv) {
      if (!state.checkPassword(srv, password)) {
        return state.send(ws, { type: 'password-required', serverName, wrong: !!password });
      }
      if (srv.users.size >= srv.maxUsers) return error(ws, 'SERVER_FULL', `Server is full (${srv.maxUsers} users).`);
    } else {
      if (state.serverCount() >= L.maxServers) {
        return error(ws, 'SERVER_LIMIT', 'Server limit reached on this host. Try again later.');
      }
      if (ip && state.serversCreatedByIp(ip) >= L.maxServersPerIp) {
        return error(ws, 'SERVER_LIMIT_IP', `You can create at most ${L.maxServersPerIp} servers at a time.`);
      }
      // A room that never uses direct connections (e.g. created from the
      // "network blocked" dialog). Refuse instead of silently creating a
      // normal room when the host can't relay.
      if (msg.createRelayOnly && !config.ice.relayAvailable) {
        return error(ws, 'RELAY_UNAVAILABLE', 'This host has no TURN relay configured, so a relay-only server cannot be created.');
      }
      srv = state.createServer(serverName, { password, ip });
      if (msg.createRelayOnly) srv.relayOnly = true;
      created = true;
      log.log(`[+] Server "${serverName}" created`);
    }

    const user = state.addUser(srv, { username, avatar, ip, relayOnly: !!msg.relayOnly });
    state.attachSocket(ws, user);
    sendServerState(ws, srv, user, created ? { createdServer: true } : {});
    state.broadcastToServer(srv, {
      type: 'user-joined-server', userId: user.id, username, channelName: null, avatar,
    }, user.id);
    log.log(`[+] ${username} (${user.id}) joined server "${serverName}"`);
  }

  // ── reconnect-session ────────────────────────────────────────────────────
  // Resumes a session (same userId, same channel) after a dropped socket.
  // Also works when the server has not noticed the old socket died yet.
  function handleReconnectSession(ws, msg) {
    if (state.userForSocket(ws)) return error(ws, 'ALREADY_JOINED', 'Already joined a server on this connection');
    const serverName = validateString(normalizeServerName(msg.serverName), L.serverNameMax);
    const srv = serverName ? state.getServer(serverName) : null;
    const user = srv ? state.getUser(srv, msg.userId) : null;
    if (!user || !safeEqual(String(msg.reconnectToken || ''), user.token)) {
      return error(ws, 'RECONNECT_FAILED', 'Session expired, please rejoin (reconnect failed)');
    }

    if (user.graceTimer) { clearTimeout(user.graceTimer); user.graceTimer = null; }
    const oldWs = user.ws;
    if (oldWs && oldWs !== ws) {
      state.detachSocket(oldWs);
      try { oldWs.close(4000, 'Session resumed elsewhere'); } catch { /* ignore */ }
    }
    if (typeof msg.relayOnly === 'boolean') user.relayOnly = msg.relayOnly;
    state.attachSocket(ws, user);
    sendServerState(ws, srv, user, { reconnected: true });

    if (user.channelKey) {
      state.broadcastToChannel(srv, user.channelKey, {
        type: 'peer-joined-channel', userId: user.id, username: user.username,
        channelName: user.channelKey, isMuted: user.isMuted, isDeafened: user.isDeafened,
        reconnected: true,
      }, user.id);
    }
    log.log(`[🔄] ${user.username} (${user.id}) reconnected to "${srv.name}"`);
  }

  // ── join-channel ─────────────────────────────────────────────────────────
  function handleJoinChannel(ws, msg, user, srv) {
    const key = typeof msg.channelName === 'string' ? msg.channelName : '';
    const ch = srv.channels.get(key);
    if (!ch) return error(ws, 'CHANNEL_NOT_FOUND', 'Channel not found');

    if (user.channelKey !== key && state.channelFull(srv, key)) {
      return error(ws, 'CHANNEL_FULL', `Channel "${ch.name}" is full (${srv.maxUsersPerChannel} users).`);
    }

    const { oldKey } = state.joinChannel(srv, user, key);
    if (oldKey) announceChannelLeave(srv, user, oldKey);

    const peers = state.channelPeers(srv, key, user.id);
    state.send(ws, {
      type: 'joined-channel',
      channelName: key,
      previousChannel: oldKey,
      existingPeers: peers.map(p => p.id),
      peerDetails: peers.map(p => ({
        userId: p.id, username: p.username, isMuted: p.isMuted, isDeafened: p.isDeafened,
      })),
      totalUsers: peers.length + 1,
    });

    state.broadcastToChannel(srv, key, {
      type: 'peer-joined-channel', userId: user.id, username: user.username, channelName: key,
      totalUsers: peers.length + 1, isMuted: user.isMuted, isDeafened: user.isDeafened,
    }, user.id);

    state.broadcastToServer(srv, {
      type: 'user-channel-update', userId: user.id, username: user.username,
      channelName: key, avatar: user.avatar,
    });
  }

  // ── leave-channel ────────────────────────────────────────────────────────
  function handleLeaveChannel(ws, msg, user, srv) {
    const oldKey = state.leaveChannel(srv, user);
    if (!oldKey) return;
    announceChannelLeave(srv, user, oldKey);
    state.send(ws, { type: 'left-channel', channelName: oldKey });
    state.broadcastToServer(srv, {
      type: 'user-channel-update', userId: user.id, username: user.username, channelName: null,
    });
  }

  // ── add-channel (creator only) ───────────────────────────────────────────
  function handleAddChannel(ws, msg, user, srv) {
    if (!isCreator(srv, user)) return error(ws, 'NOT_CREATOR', 'Only the server creator can add channels');
    const name = validateString(msg.channelName, L.channelNameMax);
    if (!name) return error(ws, 'INVALID_CHANNEL_NAME', 'Channel name required');
    const res = state.addChannel(srv, name);
    if (res.error === 'CHANNEL_LIMIT') return error(ws, 'CHANNEL_LIMIT', `Channel limit reached (${L.maxChannelsPerServer}).`);
    if (res.error) return error(ws, res.error, 'Channel already exists');
    state.broadcastToServer(srv, { type: 'channel-added', channelKey: res.key, channelName: name });
  }

  // ── change-username ──────────────────────────────────────────────────────
  function handleChangeUsername(ws, msg, user, srv) {
    const newName = validateString(msg.username, L.usernameMax);
    if (!newName || newName === user.username) return;
    const old = user.username;
    user.username = newName;
    state.broadcastToServer(srv, { type: 'user-renamed', userId: user.id, oldUsername: old, newUsername: newName });
  }

  // ── set-password (creator only) ──────────────────────────────────────────
  function handleSetPassword(ws, msg, user, srv) {
    if (!isCreator(srv, user)) return error(ws, 'NOT_CREATOR', 'Only the server creator can change the password');
    const pw = typeof msg.password === 'string' && msg.password ? validateString(msg.password, L.passwordMax) : null;
    const has = state.setPassword(srv, pw);
    state.broadcastToServer(srv, { type: 'password-updated', hasPassword: has });
    state.broadcastToServer(srv, { type: 'server-settings-updated', ...state.serverSettings(srv) });
  }

  // ── update-server-settings (creator only) ────────────────────────────────
  function handleUpdateServerSettings(ws, msg, user, srv) {
    if (!isCreator(srv, user)) return error(ws, 'NOT_CREATOR', 'Only the server creator can change settings');

    if (msg.maxUsers !== undefined) {
      const n = parseInt(msg.maxUsers, 10);
      if (!Number.isFinite(n) || n < 1) return error(ws, 'INVALID_SETTING', 'Invalid user limit');
      srv.maxUsers = Math.min(n, L.maxUsersPerServer);
    }
    if (msg.maxUsersPerChannel !== undefined) {
      const n = parseInt(msg.maxUsersPerChannel, 10);
      if (!Number.isFinite(n) || n < 2) return error(ws, 'INVALID_SETTING', 'Invalid channel limit');
      srv.maxUsersPerChannel = Math.min(n, L.maxUsersPerChannel);
    }
    if (msg.relayOnly !== undefined) {
      const want = !!msg.relayOnly;
      if (want && !config.ice.relayAvailable) {
        return error(ws, 'RELAY_UNAVAILABLE', 'This host has no TURN relay configured, so relay-only mode is unavailable.');
      }
      srv.relayOnly = want;
    }
    state.broadcastToServer(srv, { type: 'server-settings-updated', ...state.serverSettings(srv) });
  }

  // ── set-privacy (per-user preference: hide my IP) ────────────────────────
  function handleSetPrivacy(ws, msg, user) {
    user.relayOnly = !!msg.relayOnly;
    state.send(ws, { type: 'privacy-updated', relayOnly: user.relayOnly });
  }

  // ── chat-message ─────────────────────────────────────────────────────────
  function handleChatMessage(ws, msg, user, srv) {
    if (!user.channelKey) return;
    const text = validateString(msg.message, L.chatMessageMax);
    if (!text) return;
    state.broadcastToChannel(srv, user.channelKey, {
      type: 'chat-message', userId: user.id, username: user.username, message: text, timestamp: Date.now(),
    });
  }

  // ── WebRTC signaling relay ───────────────────────────────────────────────
  function cleanDescription(desc, sanitize) {
    if (!desc || typeof desc !== 'object') return null;
    if (desc.type !== 'offer' && desc.type !== 'answer') return null;
    if (typeof desc.sdp !== 'string' || desc.sdp.length > L.sdpMax) return null;
    return { type: desc.type, sdp: sanitize ? stripNonRelayFromSdp(desc.sdp) : desc.sdp };
  }

  function cleanCandidate(c, sanitize) {
    if (!c || typeof c !== 'object') return null;
    if (typeof c.candidate !== 'string' || c.candidate.length > L.candidateMax) return null;
    let candidate = c.candidate;
    if (sanitize && candidate) {
      candidate = sanitizeCandidate(candidate);
      if (!candidate) return null;
    }
    return {
      candidate,
      sdpMid: typeof c.sdpMid === 'string' ? c.sdpMid.slice(0, 32) : null,
      sdpMLineIndex: Number.isInteger(c.sdpMLineIndex) ? c.sdpMLineIndex : null,
      usernameFragment: typeof c.usernameFragment === 'string' ? c.usernameFragment.slice(0, 256) : null,
    };
  }

  // Exposed for tests: should signals from `sender` be stripped of IPs?
  function mustSanitize(srv, sender) {
    return state.relayEnforced(srv) || !!sender.relayOnly;
  }

  function handleWebRTCSignal(ws, msg, user, srv) {
    if (!user.channelKey) return;
    const target = state.getUser(srv, msg.targetId);
    if (!target || target === user || target.channelKey !== user.channelKey) return;
    const connId = typeof msg.connId === 'string' && msg.connId.length <= 64 ? msg.connId : null;
    if (!connId) return;

    const sanitize = mustSanitize(srv, user);
    const out = { type: msg.type, fromId: user.id, fromUsername: user.username, connId };
    if (msg.type === 'webrtc-ice-candidate') {
      out.candidate = cleanCandidate(msg.candidate, sanitize);
      if (!out.candidate) return;
    } else {
      const desc = cleanDescription(msg.type === 'webrtc-offer' ? msg.offer : msg.answer, sanitize);
      if (!desc) return;
      if (msg.type === 'webrtc-offer') out.offer = desc; else out.answer = desc;
    }
    state.sendToUser(target, out);
  }

  // ── Client state broadcast (mute/deafen status) ──────────────────────────
  function handleClientState(ws, msg, user, srv) {
    const value = !!msg.value;
    if (msg.type === 'mute-state-changed') user.isMuted = value;
    else user.isDeafened = value;
    if (!user.channelKey) return;
    state.broadcastToChannel(srv, user.channelKey, {
      type: msg.type, userId: user.id, username: user.username, value,
    }, user.id);
  }

  // ── File announce relay ──────────────────────────────────────────────────
  function handleFileAnnounce(ws, msg, user, srv) {
    if (!user.channelKey) return;
    const fileName = validateString(msg.fileName, L.fileNameMax);
    if (!fileName) return;
    if (typeof msg.fileId !== 'string' || !/^[A-Za-z0-9]{1,32}$/.test(msg.fileId)) return;
    const fileSize = Number.isFinite(msg.fileSize) && msg.fileSize >= 0 ? Math.floor(msg.fileSize) : 0;
    const fileType = typeof msg.fileType === 'string' ? msg.fileType.slice(0, 100) : '';
    state.broadcastToChannel(srv, user.channelKey, {
      type: 'file-announce', userId: user.id, username: user.username,
      fileId: msg.fileId, fileName, fileSize, fileType,
    }, user.id);
  }

  // ── Avatar change relay ──────────────────────────────────────────────────
  function handleAvatarChanged(ws, msg, user, srv) {
    user.avatar = validateAvatar(msg.avatar, L.avatarMax);
    state.broadcastToServer(srv, { type: 'avatar-changed', userId: user.id, avatar: user.avatar });
  }

  // ── Video state relay ────────────────────────────────────────────────────
  function handleVideoStateChanged(ws, msg, user, srv) {
    if (!user.channelKey) return;
    state.broadcastToChannel(srv, user.channelKey, {
      type: 'video-state-changed', userId: user.id, active: !!msg.active,
      source: msg.source === 'screen' ? 'screen' : 'camera',
    }, user.id);
  }

  // ── Intentional leave ────────────────────────────────────────────────────
  function handleIntentionalDisconnect(ws, msg, user) {
    state.detachSocket(ws);
    removeUserAndNotify(user, 'left');
  }

  // ── Routing ──────────────────────────────────────────────────────────────

  const userHandlers = {
    'join-channel': handleJoinChannel,
    'leave-channel': handleLeaveChannel,
    'add-channel': handleAddChannel,
    'change-username': handleChangeUsername,
    'set-password': handleSetPassword,
    'update-server-settings': handleUpdateServerSettings,
    'set-privacy': handleSetPrivacy,
    'chat-message': handleChatMessage,
    'file-announce': handleFileAnnounce,
    'avatar-changed': handleAvatarChanged,
    'video-state-changed': handleVideoStateChanged,
    'mute-state-changed': handleClientState,
    'deafen-state-changed': handleClientState,
    'webrtc-offer': handleWebRTCSignal,
    'webrtc-answer': handleWebRTCSignal,
    'webrtc-ice-candidate': handleWebRTCSignal,
    'get-ice-servers': (ws, msg, user) => state.send(ws, { type: 'ice-servers', iceServers: iceServersFor(user) }),
    'disconnect': handleIntentionalDisconnect,
  };

  function route(ws, msg) {
    if (!msg || typeof msg.type !== 'string') return;
    let buckets = rate.get(ws);
    if (!buckets) rate.set(ws, buckets = {});
    if (!takeToken(buckets, SIGNAL_TYPES.has(msg.type) ? 'signal' : 'general')) {
      if (!buckets.warned) { log.warn('[!] Rate limit exceeded for a connection'); buckets.warned = true; }
      return;
    }

    if (msg.type === 'ping') return state.send(ws, { type: 'pong' });
    if (msg.type === 'join-server') return handleJoinServer(ws, msg);
    if (msg.type === 'reconnect-session') return handleReconnectSession(ws, msg);

    const handler = userHandlers[msg.type];
    if (!handler) return;
    const { user, srv } = current(ws);
    if (!user) return error(ws, 'NOT_IN_SERVER', 'Not in a server');
    return handler(ws, msg, user, srv);
  }

  // Socket closed (network drop, tab killed, …) → keep the user for a grace
  // period so a quick reconnect resumes the same session.
  function handleClose(ws) {
    const info = state.unregisterSocket(ws);
    const user = info?.user;
    if (!user || user.ws !== ws) return;
    user.ws = null;
    const srv = state.getServer(user.serverName);
    if (!srv || srv.users.get(user.id) !== user) return;
    startGrace(user);
  }

  return { route, handleClose, mustSanitize, _takeToken: takeToken };
}

module.exports = { createHandlers, takeToken, BUCKETS };
