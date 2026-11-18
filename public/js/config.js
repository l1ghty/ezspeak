// ── Constants ────────────────────────────────────────────────────────────────
// Loaded right after shared.js — no other dependencies.

// Fallback only: the signaling server sends the real ICE server list
// (including TURN credentials, if configured) in `server-state`.
const RTC_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
  ]
};

const LS_USERNAME   = 'ezspeak_username';
const LS_RECENT     = 'ezspeak_recent_servers';
const LS_RELAY_ONLY = 'ezspeak_relay_only';   // '1' → hide my IP (TURN relay only)
const SS_PASSWORD   = 'ezspeak_pw';
