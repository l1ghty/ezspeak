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

// Secret from VAR or from the file named by VAR_FILE (Docker secrets /
// a volume written by an init container). The direct value wins.
function secret(env, key, readFile) {
  if (env[key]) return String(env[key]).trim();
  const file = env[key + '_FILE'];
  if (!file) return '';
  try {
    return String(readFile(file)).trim();
  } catch (err) {
    throw new Error(`${key}_FILE: cannot read ${file} (${err.code || err.message})`);
  }
}

const DEFAULT_TURN_PORT = 3478;

function loadConfig(env = process.env, { readFile = (f) => require('fs').readFileSync(f, 'utf8') } = {}) {
  const turnSecret = secret(env, 'TURN_SECRET', readFile);
  const turnPort = int(env, 'TURN_PORT', DEFAULT_TURN_PORT, 1, 65535);
  // With a secret but no explicit URLs, point clients at the host they
  // loaded the page from ({host} is filled in per connection).
  const defaultTurnUrls = turnSecret
    ? [`turn:{host}:${turnPort}?transport=udp`, `turn:{host}:${turnPort}?transport=tcp`]
    : [];

  const cfg = {
    port: int(env, 'PORT', 3000, 0, 65535),
    // Number of trusted reverse proxies in front of the app (true = 1).
    trustProxy: /^\d+$/.test(String(env.TRUST_PROXY || '').trim())
      ? int(env, 'TRUST_PROXY', 0, 0, 10)
      : (bool(env, 'TRUST_PROXY', false) ? 1 : 0),
    // Extra origins allowed to open WebSockets (own origin is always allowed).
    allowedOrigins: list(env, 'ALLOWED_ORIGINS', []),

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
      // New WebSocket connections per IP per minute
      connectRatePerIp:     int(env, 'CONNECT_RATE_PER_IP', 60, 1),
      // Wrong passwords per IP per 10 minutes before further tries are refused
      passwordFailsPerIp:   int(env, 'PASSWORD_FAILS_PER_IP', 10, 1),
      // Sockets that haven't joined a server by then are closed
      joinTimeoutMs:        int(env, 'JOIN_TIMEOUT_MS', 30000, 1000),

      // Input sizes
      usernameMax: 24,
      serverNameMax: 32,
      channelNameMax: 24,
      chatMessageMax: 2000,
      passwordMax: 128,
      fileNameMax: 255,
      avatarMax: 24000,
      sdpMax: 32000,
      candidateMax: 1024,
    },

    disconnectGraceMs: int(env, 'DISCONNECT_GRACE_MS', 30000, 0),
    pingIntervalMs: int(env, 'PING_INTERVAL_MS', 30000, 1000),

    ice: {
      // Every user's IP is hidden from other users on every server.
      forceRelay: bool(env, 'FORCE_RELAY', false),
      stunUrls: list(env, 'STUN_URLS', ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']),
      // May contain {host} → replaced by the hostname the client connected to
      turnUrls: list(env, 'TURN_URLS', defaultTurnUrls),
      // coturn `use-auth-secret` / `static-auth-secret` → short-lived credentials
      turnSecret,
      // …or fixed credentials
      turnUsername: env.TURN_USERNAME || '',
      turnCredential: env.TURN_CREDENTIAL || '',
      // Short-lived on purpose: clients refresh before expiry.
      turnTtlSec: int(env, 'TURN_TTL', 21600, 300),
    },
  };
  if (cfg.ice.turnUrls.length === 0 && turnSecret) cfg.ice.turnUrls = defaultTurnUrls;
  cfg.ice.relayAvailable = cfg.ice.turnUrls.length > 0 &&
    !!(cfg.ice.turnSecret || (cfg.ice.turnUsername && cfg.ice.turnCredential));
  cfg.limits.maxUsersPerChannel = Math.min(cfg.limits.maxUsersPerChannel, cfg.limits.maxUsersPerServer);
  return cfg;
}

module.exports = { loadConfig };
