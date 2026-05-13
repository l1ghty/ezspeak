// ── Chat ────────────────────────────────────────────────────────────────────
// Manages chat message display in the chat panel.
// Depends on: storage.js (escapeHtml), uses DOM refs from app.js

function addChatMessage(senderId, senderName, message, timestamp, isSystem) {
  const div = document.createElement('div');
  div.className = 'chat-msg' + (isSystem ? ' system' : '');
  const time = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isSystem) {
    div.innerHTML = `<span class="msg-text">${escapeHtml(message)}</span>`;
  } else {
    const isSelf = senderId === userId;
    div.innerHTML = `<span class="msg-author">${isSelf ? 'You' : escapeHtml(senderName)}</span><span class="msg-text">${escapeHtml(message)}</span><span class="msg-time">${time}</span>`;
  }
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showChat() {
  chatPanel.style.display = '';
}

function hideChat() {
  chatPanel.style.display = 'none';
}

function clearChat() {
  chatMessages.innerHTML = '';
}

function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text || !currentChannel) return;
  sendWs({ type: 'chat-message', message: text });
  chatInput.value = '';
}

// ── File messages ──────────────────────────────────────────────────────────

function addFileMessage(peerId, peerName, fileName, blob, sizeBytes, fileId, isOutgoing) {
  const div = document.createElement('div');
  div.className = 'chat-msg file-msg';
  const sizeStr = formatFileSize(sizeBytes);
  const sender = isOutgoing ? 'You' : escapeHtml(peerName);

  if (isOutgoing || blob) {
    // Outgoing or already-downloaded file — show as link
    const url = blob ? URL.createObjectURL(blob) : '#';
    div.innerHTML = `
      <span class="msg-author">${sender}</span>
      <span class="file-icon">📎</span>
      <a class="file-link" href="${url}" download="${escapeHtml(fileName)}" target="_blank">
        ${escapeHtml(fileName)}
      </a>
      <span class="file-size">${sizeStr}</span>
    `;
  } else {
    // Incoming metadata — show Download button (or unsupported warning)
    const tooBig = sizeBytes > 500 * 1024 * 1024 && !window.showSaveFilePicker;
    if (tooBig) {
      div.innerHTML = `
        <span class="msg-author">${sender}</span>
        <span class="file-icon">📎</span>
        <span class="file-name">${escapeHtml(fileName)}</span>
        <span class="file-size">${sizeStr}</span>
        <span class="file-warn">⚠️ Too large for this browser — use Chrome</span>
      `;
    } else {
      div.innerHTML = `
        <span class="msg-author">${sender}</span>
        <span class="file-icon">📎</span>
        <span class="file-name">${escapeHtml(fileName)}</span>
        <span class="file-size">${sizeStr}</span>
        <button class="file-dl-btn" data-peer="${peerId}" data-fileid="${fileId}">⬇ Download</button>
      `;
    }
  }
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  // Wire up download button
  if (!isOutgoing && !blob) {
    const btn = div.querySelector('.file-dl-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        if (typeof requestFile === 'function') {
          requestFile(btn.dataset.peer, btn.dataset.fileid);
        }
      });
    }
  }
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
