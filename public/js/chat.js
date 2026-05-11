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
