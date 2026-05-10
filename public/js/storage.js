// ── Persistent storage ──────────────────────────────────────────────────────
// Username, recent servers — all stored in localStorage / sessionStorage.

// --- browser detection -------------------------------------------------------

function detectBrowser() {
  const ua = navigator.userAgent;
  if (ua.includes('Firefox')) return 'firefox';
  if (ua.includes('Edg')) return 'edge';
  if (ua.includes('Chrome')) return 'chrome';
  if (ua.includes('Safari')) return 'safari';
  return 'web';
}

function generateDefaultUsername() {
  const num = Math.floor(1000 + Math.random() * 9000);
  return `ezhuman-${detectBrowser()}-${num}`;
}

// --- username ----------------------------------------------------------------

function loadSavedUsername() {
  return localStorage.getItem(LS_USERNAME) || generateDefaultUsername();
}

function saveUsername(name) {
  if (name && name.trim()) localStorage.setItem(LS_USERNAME, name.trim());
}

// --- recent servers ----------------------------------------------------------

function loadRecentServers() {
  try { return JSON.parse(localStorage.getItem(LS_RECENT) || '[]'); } catch { return []; }
}

function saveRecentServer(name, hasPassword) {
  const servers = loadRecentServers().filter(s => s.name !== name);
  servers.unshift({ name, hasPassword, timestamp: Date.now() });
  localStorage.setItem(LS_RECENT, JSON.stringify(servers.slice(0, 10)));
}

function updateRecentServerPassword(name, hasPassword) {
  const servers = loadRecentServers();
  const s = servers.find(s => s.name === name);
  if (s) { s.hasPassword = hasPassword; localStorage.setItem(LS_RECENT, JSON.stringify(servers)); }
}

function removeRecentServer(name) {
  localStorage.setItem(LS_RECENT, JSON.stringify(loadRecentServers().filter(s => s.name !== name)));
}

// --- formatting --------------------------------------------------------------

function formatTimeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
