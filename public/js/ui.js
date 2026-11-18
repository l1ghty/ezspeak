// ── UI ──────────────────────────────────────────────────────────────────────
// DOM rendering: channel list, user list, modals, connection status.
// Depends on: storage.js, webrtc.js, audio.js.  Uses DOM refs from app.js.

// --- Channel list ------------------------------------------------------------

function renderChannels(channels) {
  channelList.innerHTML = '';
  for (const [key, ch] of Object.entries(channels)) {
    const users = Object.values(ch.users);
    const userCount = users.length;
    const div = document.createElement('div');
    div.className = 'channel-item' + (currentChannel === key ? ' active' : '');
    div.innerHTML = `
      <div class="channel-row">
        <span class="channel-icon">${userCount > 0 ? '🔊' : '🔇'}</span>
        <span class="channel-name">${escapeHtml(ch.name)}</span>
        <span class="channel-count">${userCount}${serverState?.maxUsersPerChannel ? '/' + serverState.maxUsersPerChannel : ''}</span>
      </div>
      ${userCount > 0 ? `
        <div class="channel-users">
          ${users.map(u => `<span class="channel-user">${escapeHtml(u.username)}</span>`).join('')}
        </div>
      ` : ''}
    `;
    div.addEventListener('click', () => joinChannel(key));
    channelList.appendChild(div);
  }
}

// --- User list in current channel --------------------------------------------

let _sliderDragging = false;
let _pendingUserListRender = false;
window.addEventListener('pointerup', () => {
  if (!_sliderDragging) return;
  _sliderDragging = false;
  if (_pendingUserListRender && currentChannel) renderChannelUsers(currentChannel);
});

// Toggle just the speaking glow (cheap; called ~8×/s while people talk).
function updateSpeakingIndicator(peerId, speaking) {
  const id = peerId === '__self__' ? userId : peerId;
  if (id == null) return;
  const el = userList.querySelector(`.user-avatar[data-uid="${CSS.escape(String(id))}"]`);
  if (el) el.classList.toggle('speaking', !!speaking);
}

function renderChannelUsers(channelName) {
  if (!channelName || !serverState || !serverState.channels[channelName]) {
    userList.innerHTML = '<p class="placeholder">Select a channel from the sidebar to start talking</p>';
    channelUserCount.textContent = '';
    return;
  }
  const channel = serverState.channels[channelName];
  const users = Object.values(channel.users);
  channelUserCount.textContent = `${users.length} user${users.length !== 1 ? 's' : ''}`;
  currentChannelTitle.textContent = channel.name;

  if (users.length === 0) {
    userList.innerHTML = '<p class="placeholder">No one here yet. Invite friends!</p>';
    return;
  }

  // Don't rebuild the list while the user drags a volume slider.
  const active = document.activeElement;
  if (active && active.classList?.contains('vol-slider') && userList.contains(active) && _sliderDragging) {
    _pendingUserListRender = true;
    return;
  }
  _pendingUserListRender = false;

  userList.innerHTML = users.map(u => {
    const isSelf = u.userId === userId;
    // Self uses WebSocket state; others use WebRTC peer connection state
    const connState = isSelf
      ? ((typeof isWebSocketOpen === 'function' && isWebSocketOpen()) ? 'connected' : 'disconnected')
      : getPeerConnectionState(u.userId);
    const speaking = isSelf ? isSelfSpeaking() : isPeerSpeaking(u.userId);
    const selfCamera = isSelf && typeof isSharingVideo === 'function' && isSharingVideo() && (typeof isSharingScreen === 'function' ? !isSharingScreen() : true);
    const initial = (u.username || '?')[0].toUpperCase();
    const avatarUrl = serverState?.users[u.userId]?.avatar || null;
    const peerMuted = isPeerMutedLocally(u.userId);
    const peerVol = getPeerVolume(u.userId);
    // Server-side state (broadcast by the user themselves)
    const isUserMuted = serverState?.users[u.userId]?.isMuted || false;
    const isUserDeafened = serverState?.users[u.userId]?.isDeafened || false;
    const noMic = isSelf && !hasLocalStream();
    const hasVideo = !isSelf && hasPeerVideo(u.userId);
    const peerVideoSrc = hasVideo ? (getPeerVideoSource(u.userId) || 'camera') : null;
    const videoLabel = peerVideoSrc === 'screen' ? 'screen' : 'camera';
    const recordClass = hasVideo && peerVideoSrc === 'camera' ? '<span class="record-dot"></span>' : '';
    const videoIcon = peerVideoSrc === 'screen' ? '🖥️' : '';

    return `
      <div class="user-item">
        <div data-uid="${escapeHtml(String(u.userId))}" class="user-avatar ${isSelf ? 'self' : ''} ${speaking ? 'speaking' : ''} ${selfCamera ? 'camera-active' : ''}"${avatarUrl ? ` style="background-image:url(${avatarUrl});background-size:cover;background-position:center;color:transparent"` : ''}>
          ${avatarUrl ? '' : initial}
          ${noMic ? '<span class="user-status-icon no-mic" title="No microphone">🎤✕</span>' : ''}
          ${isUserMuted ? '<span class="user-status-icon muted" title="Muted">🤐</span>' : ''}
          ${isUserDeafened ? '<span class="user-status-icon deafened" title="Deafened">🙉</span>' : ''}
        </div>
        <div class="user-info">
          <span class="user-name">${escapeHtml(u.username)} ${isSelf ? '(you)' : ''}</span>
          ${!isSelf ? `
          <div class="user-controls">
            <input type="range" class="vol-slider" min="0" max="100" value="${Math.round(peerVol)}"
              data-peer="${u.userId}" title="Volume: ${Math.round(peerVol)}%" />
            <button class="peer-mute-btn ${peerMuted ? 'active' : ''}" data-peer="${u.userId}"
              title="${peerMuted ? 'Unmute' : 'Mute'} ${escapeHtml(u.username)}">
              ${peerMuted ? '🔇' : '🔊'}
            </button>
            ${hasVideo ? `<button class="peer-camera-btn" data-peer="${u.userId}" title="View ${escapeHtml(u.username)}'s ${videoLabel}">${recordClass}${videoIcon} ${peerVideoSrc === 'screen' ? 'Screen' : 'Open Cam'}</button>` : ''}
          </div>
          ` : ''}
        </div>
        <div class="user-indicator ${connState}" title="${connState === 'connected' ? 'Voice connected' : connState === 'connecting' ? 'Connecting voice…' : 'Not connected'}"></div>
      </div>
    `;
  }).join('');

  // Wire up volume sliders
  userList.querySelectorAll('.vol-slider').forEach(slider => {
    slider.addEventListener('pointerdown', () => { _sliderDragging = true; });
    slider.addEventListener('change', () => {
      _sliderDragging = false;
      if (_pendingUserListRender && currentChannel) renderChannelUsers(currentChannel);
    });
    slider.addEventListener('input', (e) => {
      const peerId = e.target.dataset.peer;
      const vol = parseInt(e.target.value); // 0-200
      setPeerVolume(peerId, vol);
      e.target.title = 'Volume: ' + vol + '%';
    });
  });

  // Wire up camera buttons
  userList.querySelectorAll('.peer-camera-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const peerId = e.target.closest('.peer-camera-btn').dataset.peer;
      if (typeof openVideoModal === 'function') openVideoModal(peerId);
    });
  });

  // Wire up per-user mute buttons
  userList.querySelectorAll('.peer-mute-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const peerId = e.target.closest('.peer-mute-btn').dataset.peer;
      const nowMuted = togglePeerMute(peerId);
      btn.classList.toggle('active', nowMuted);
      const peerName = serverState?.channels[channelName]?.users[peerId]?.username || 'user';
      btn.title = (nowMuted ? 'Unmute' : 'Mute') + ' ' + peerName;
      btn.textContent = nowMuted ? '🔇' : '🔊';
    });
  });
}

function updateOnlineCount(users) {
  onlineCount.textContent = `${Object.keys(users).length} online`;
}

// --- Connection status -------------------------------------------------------

function setConnectionStatus(status, text) {
  statusDot.className = 'dot ' + status;
  statusText.textContent = text;
  // Re-render user list so self indicator reflects connection state
  if (typeof currentChannel !== 'undefined' && currentChannel) {
    renderChannelUsers(currentChannel);
  }
}

// --- Recent servers modal ----------------------------------------------------

function showRecentModal() {
  renderRecentServers();
  recentModal.style.display = 'flex';
}

function hideRecentModal() {
  recentModal.style.display = 'none';
}

function renderRecentServers() {
  const servers = loadRecentServers();
  if (servers.length === 0) {
    recentList.innerHTML = '<p class="placeholder">No recent servers yet. Join one to see it here!</p>';
    return;
  }
  recentList.innerHTML = servers.map(s => `
    <div class="recent-item" data-server="${escapeHtml(s.name)}">
      <span class="recent-icon">🔊</span>
      <span class="recent-name">${escapeHtml(s.name)}</span>
      ${s.hasPassword ? '<span class="recent-lock">🔒</span>' : ''}
      <span class="recent-time">${formatTimeAgo(s.timestamp)}</span>
      <button class="recent-delete" data-server="${escapeHtml(s.name)}" title="Remove">✕</button>
    </div>
  `).join('');

  recentList.querySelectorAll('.recent-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('recent-delete')) return;
      hideRecentModal();
      navigateToServer(item.dataset.server);
    });
  });
  recentList.querySelectorAll('.recent-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeRecentServer(btn.dataset.server);
      renderRecentServers();
    });
  });
}

// --- Password modal (join) ---------------------------------------------------

function showPasswordModal() {
  pwModalInput.value = '';
  pwError.style.display = 'none';
  passwordModal.style.display = 'flex';
  pwModalInput.focus();
}

function hidePasswordModal() {
  passwordModal.style.display = 'none';
}

// --- Rename modal ------------------------------------------------------------

function showRenameModal() {
  renameInput.value = username;
  renameModal.style.display = 'flex';
  renameInput.focus();
}

function hideRenameModal() {
  renameModal.style.display = 'none';
}

// --- Server settings modal (creator) ---------------------------------------

function showSetPwModal() {
  setPwInput.value = '';
  const removePw = document.getElementById('remove-pw-check');
  const maxUsers = document.getElementById('max-users-input');
  const maxCh = document.getElementById('max-channel-users-input');
  const relay = document.getElementById('relay-only-check');
  const hint = document.getElementById('relay-only-hint');
  const st = serverState || {};
  const lim = st.limits || {};
  removePw.checked = false;
  removePw.disabled = !st.hasPassword;
  maxUsers.value = st.maxUsers || '';
  maxUsers.max = lim.maxUsersPerServer || '';
  maxCh.value = st.maxUsersPerChannel || '';
  maxCh.max = lim.maxUsersPerChannel || '';
  relay.checked = !!st.relayOnly;
  relay.disabled = !st.relayAvailable;
  hint.textContent = !st.relayAvailable
    ? 'Unavailable: this host has no TURN relay configured.'
    : (st.forceRelay && !st.relayOnly)
      ? 'The host already relays all voice — IPs are hidden on every server.'
      : 'Voice goes through the TURN relay instead of directly between users, so nobody in this server can see anyone else\'s IP address. Uses a bit more latency.';
  setPwModal.style.display = 'flex';
  setPwInput.focus();
}

function hideSetPwModal() {
  setPwModal.style.display = 'none';
}

// --- Creator UI toggle -------------------------------------------------------

function showCreatorTools() {
  addChannelSection.style.display = 'block';
  const pwHeader = document.getElementById('set-pw-btn-header');
  if (pwHeader) pwHeader.style.display = '';
}

function hideCreatorTools() {
  addChannelSection.style.display = 'none';
  const pwHeader = document.getElementById('set-pw-btn-header');
  if (pwHeader) pwHeader.style.display = 'none';
}

// --- Privacy badge -----------------------------------------------------------

function updatePrivacyBadge() {
  const badge = document.getElementById('privacy-badge');
  if (!badge) return;
  const relay = typeof isRelayOnly === 'function' && isRelayOnly();
  badge.style.display = relay ? '' : 'none';
  if (relay && typeof canUseRelay === 'function' && !canUseRelay()) {
    badge.textContent = '⚠️ Relay unavailable';
    badge.title = 'Relay-only mode is on, but this host has no TURN relay — voice cannot connect.';
  } else {
    badge.textContent = '🛡️ IP hidden';
    badge.title = 'Voice is relayed — your IP is hidden from other users';
  }
}

// --- Channel header ----------------------------------------------------------

function setChannelTitle(name) {
  if (name && typeof serverName !== 'undefined' && serverName) {
    currentChannelTitle.textContent = serverName + ' | ' + name;
  } else {
    currentChannelTitle.textContent = name || 'Not in a channel';
  }
}

// --- Network blocked warning -------------------------------------------------
// kind: 'p2p-blocked'      direct WebRTC never connected → offer a relay room
//       'relay-blocked'    even the TURN relay couldn't connect
//       'signaling-blocked' the WebSocket to the server can't be opened

function networkWarningContent(kind, { peerName, relayAvailable, httpOk } = {}) {
  const who = peerName ? escapeHtml(peerName) : 'another user';
  if (kind === 'signaling-blocked') {
    return {
      title: '⚠️ Can\'t reach the server',
      message: httpOk
        ? 'The page loads, but the live connection to the server (WebSocket) is being blocked.'
        : 'The ezspeak server can\'t be reached from your network right now.',
      causes: httpOk
        ? ['A company, school or public Wi-Fi firewall or web filter', 'A proxy, VPN or security software inspecting traffic', 'A browser extension blocking WebSockets']
        : ['You are offline or the connection is unstable', 'A firewall blocks this site', 'The server is down or restarting'],
      hint: 'ezspeak keeps retrying in the background. Switching networks (e.g. to mobile data) usually helps.',
      relayButtons: false,
    };
  }
  if (kind === 'relay-blocked') {
    return {
      title: '⚠️ Relay connection failed',
      message: `Voice with <strong>${who}</strong> couldn't connect, even through the relay server.`,
      causes: ['Your network blocks the relay server\'s ports too', 'A strict VPN or proxy', 'The relay server is unreachable or overloaded'],
      hint: 'Try another network (e.g. mobile data), or ask the host admin to offer the relay over TLS on port 443.',
      relayButtons: false,
    };
  }
  return {
    title: '⚠️ Connection blocked',
    message: `Voice with <strong>${who}</strong> couldn't connect. Your network (or theirs) seems to block direct connections between users.`,
    causes: ['Company, school or public Wi-Fi firewall', 'VPN, proxy or security software', 'Strict NAT (some mobile carriers / routers)'],
    hint: relayAvailable
      ? 'A relay room sends everyone\'s voice through this host\'s relay server instead of directly between users. That works through most firewalls and also hides everyone\'s IP address. You\'ll get a new link to share with the others.'
      : 'This host has no relay (TURN) server configured, so a relay room can\'t be created here. Try another network (e.g. mobile data), or ask the host admin to set up TURN.',
    relayButtons: !!relayAvailable,
  };
}

function showNetworkWarning(kind, opts = {}) {
  const modal = document.getElementById('network-warning-modal');
  if (!modal) return;
  const c = networkWarningContent(kind, opts);
  document.getElementById('network-warning-title').textContent = c.title;
  document.getElementById('network-warning-message').innerHTML = c.message;
  document.getElementById('network-warning-causes').innerHTML =
    c.causes.map(x => `<li>${escapeHtml(x)}</li>`).join('');
  document.getElementById('network-warning-hint').textContent = c.hint;
  document.getElementById('network-warning-relay-room').style.display = c.relayButtons ? '' : 'none';
  document.getElementById('network-warning-relay-me').style.display = c.relayButtons ? '' : 'none';
  modal.dataset.kind = kind;
  modal.style.display = 'flex';
}

function hideNetworkWarning() {
  const modal = document.getElementById('network-warning-modal');
  if (modal) modal.style.display = 'none';
}

function isNetworkWarningOpen() {
  return document.getElementById('network-warning-modal')?.style.display === 'flex';
}
