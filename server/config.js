// ── Configuration (environment variables → typed config) ───────────────────
// Pure function so it can be unit-tested with a fake env.

function int(env, key, def, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function bool(env, key, def) {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

function list(env, key, def) {
  const raw = env[key];
  if (raw === undefined) return def;
  return String(raw).split(',').map(s => s.trim()).filter(Boolean);
}

function loadConfig(env = process.env) {
  const cfg = {
    port: int(env, 'PORT', 3000, 0, 65535),
    trustProxy: bool(env, 'TRUST_PROXY', false),

    limits: {
      // Global hosting limits
      maxConnections:       int(env, 'MAX_CONNECTIONS', 500, 1),
      maxConnectionsPerIp:  int(env, 'MAX_CONNECTIONS_PER_IP', 20, 1),
      maxServers:           int(env, 'MAX_SERVERS', 100, 1),
      maxServersPerIp:      int(env, 'MAX_SERVERS_PER_IP', 5, 1),
      maxUsersPerServer:    int(env, 'MAX_USERS_PER_SERVER', 50, 1),
      // Full-mesh WebRTC: every user uploads to every other user, so voice
      // quality degrades quickly above ~10 people in one channel.
      maxUsersPerChannel:   int(env, 'MAX_USERS_PER_CHANNEL', 10, 2),
      maxChannelsPerServer: int(env, 'MAX_CHANNELS_PER_SERVER', 20, 1),

      // Input sizes
      usernameMax: 24,
      serverNameMax: 32,
      channelNameMax: 24,
      chatMessageMax: 2000,
      passwordMax: 128,
      fileNameMax: 255,
      avatarMax: 48000,
      sdpMax: 60000,
      candidateMax: 1024,
    },

    disconnectGraceMs: int(env, 'DISCONNECT_GRACE_MS', 30000, 0),
    pingIntervalMs: int(env, 'PING_INTERVAL_MS', 30000, 1000),

    ice: {
      // Every user's IP is hidden from other users on every server.
      forceRelay: bool(env, 'FORCE_RELAY', false),
      stunUrls: list(env, 'STUN_URLS', ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']),
      turnUrls: list(env, 'TURN_URLS', []),
      // coturn `use-auth-secret` / `static-auth-secret` → short-lived credentials
      turnSecret: env.TURN_SECRET || '',
      // …or fixed credentials
      turnUsername: env.TURN_USERNAME || '',
      turnCredential: env.TURN_CREDENTIAL || '',
      turnTtlSec: int(env, 'TURN_TTL', 86400, 60),
    },
  };
  cfg.ice.relayAvailable = cfg.ice.turnUrls.length > 0 &&
    !!(cfg.ice.turnSecret || (cfg.ice.turnUsername && cfg.ice.turnCredential));
  cfg.limits.maxUsersPerChannel = Math.min(cfg.limits.maxUsersPerChannel, cfg.limits.maxUsersPerServer);
  return cfg;
}

module.exports = { loadConfig };
