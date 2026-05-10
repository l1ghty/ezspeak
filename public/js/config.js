// ── Constants ────────────────────────────────────────────────────────────────
// Loaded first — zero dependencies.

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

const LS_USERNAME = 'ezspeak_username';
const LS_RECENT   = 'ezspeak_recent_servers';
const SS_PASSWORD = 'ezspeak_pw';
