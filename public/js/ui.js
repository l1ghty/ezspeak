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
        <span class="channel-count">${userCount}</span>
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

  userList.innerHTML = users.map(u => {
    const isSelf = u.userId === userId;
    const isConnected = isSelf || hasPeerConnection(u.userId);
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
        <div class="user-avatar ${isSelf ? 'self' : ''} ${speaking ? 'speaking' : ''} ${selfCamera ? 'camera-active' : ''}"${avatarUrl ? ` style="background-image:url(${avatarUrl});background-size:cover;background-position:center;color:transparent"` : ''}>
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
        <div class="user-indicator ${isConnected ? 'connected' : 'disconnected'}"></div>
      </div>
    `;
  }).join('');

  // Wire up volume sliders
  userList.querySelectorAll('.vol-slider').forEach(slider => {
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

// --- Set password modal ------------------------------------------------------

function showSetPwModal() {
  setPwInput.value = '';
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

// --- Channel header ----------------------------------------------------------

function setChannelTitle(name) {
  if (name && typeof serverName !== 'undefined' && serverName) {
    currentChannelTitle.textContent = serverName + ' | ' + name;
  } else {
    currentChannelTitle.textContent = name || 'Not in a channel';
  }
}
