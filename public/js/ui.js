// ── UI ──────────────────────────────────────────────────────────────────────
// DOM rendering: channel list, user list, modals, connection status.
// Depends on: storage.js, webrtc.js, audio.js.  Uses DOM refs from app.js.

// --- Channel list ------------------------------------------------------------

function renderChannels(channels) {
  channelList.innerHTML = '';
  for (const [key, ch] of Object.entries(channels)) {
    const userCount = Object.keys(ch.users).length;
    const div = document.createElement('div');
    div.className = 'channel-item' + (currentChannel === key ? ' active' : '');
    div.innerHTML = `
      <span class="channel-icon">${userCount > 0 ? '🔊' : '🔇'}</span>
      <span class="channel-name">${escapeHtml(ch.name)}</span>
      <span class="channel-count">${userCount}</span>
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
    const initial = (u.username || '?')[0].toUpperCase();
    return `
      <div class="user-item">
        <div class="user-avatar ${isSelf ? 'self' : ''} ${speaking ? 'speaking' : ''}">${initial}</div>
        <span class="user-name">${escapeHtml(u.username)} ${isSelf ? '(you)' : ''}</span>
        ${isSelf ? '<span class="user-badge">You</span>' : ''}
        <div class="user-indicator ${isConnected ? 'connected' : 'disconnected'}"></div>
      </div>
    `;
  }).join('');
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
  setPwBtn.style.display = '';
}

// --- Channel header ----------------------------------------------------------

function setChannelTitle(name) {
  currentChannelTitle.textContent = name || 'Not in a channel';
}
