// ── Abuse protection helpers ────────────────────────────────────────────────
// Pure / self-contained so they can be unit-tested.

const net = require('net');

// Key used for per-IP limits. IPv4-mapped IPv6 → IPv4; IPv6 → its /64,
// because one subscriber usually controls a whole /64 and could otherwise
// rotate addresses to dodge every limit.
function ipKey(ip) {
  if (typeof ip !== 'string' || !ip) return 'unknown';
  let a = ip.trim();
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) a = mapped[1];
  if (net.isIPv4(a)) return a;
  if (!net.isIPv6(a)) return 'unknown';
  // Expand to 8 groups and keep the first 4.
  const [head, tail = ''] = a.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = a.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return groups.slice(0, 4).map(g => parseInt(g, 16).toString(16)).join(':') + '::/64';
}

// Client IP. With `hops` trusted reverse proxies in front of us, the real
// client is the hops-th address from the RIGHT of X-Forwarded-For — the
// left part is whatever the client sent and must not be trusted.
function clientIp(req, hops) {
  const remote = req.socket?.remoteAddress || 'unknown';
  if (!hops) return remote;
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd !== 'string' || !fwd.trim()) return remote;
  const parts = fwd.split(',').map(s => s.trim()).filter(Boolean);
  return parts[parts.length - hops] || parts[0] || remote;
}

// Last-hop value of a proxy header that may be comma-separated.
function lastHop(value, hops) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parts = value.split(',').map(s => s.trim()).filter(Boolean);
  return parts[parts.length - Math.max(1, hops)] || parts[0];
}

// Browsers always send Origin on WebSocket upgrades. Only allow our own
// origin (or explicitly configured ones) so other websites can't use this
// server's signaling and TURN relay. Non-browser clients send no Origin.
function originAllowed(origin, host, allowedOrigins = []) {
  if (!origin) return true;
  if (allowedOrigins.includes('*')) return true;
  let o;
  try { o = new URL(origin); } catch { return false; }
  if (allowedOrigins.some(a => a.replace(/\/+$/, '').toLowerCase() === o.origin.toLowerCase())) return true;
  return !!host && o.host.toLowerCase() === String(host).toLowerCase();
}

// Fixed-window counter per key (e.g. connections per IP per minute).
function createWindowLimiter({ limit, windowMs, now = () => Date.now() }) {
  const hits = new Map(); // key → { count, resetAt }
  function sweep(t) {
    if (hits.size < 10000) return;
    for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
  }
  return {
    // Records a hit; returns false when the key is over the limit.
    hit(key) {
      const t = now();
      sweep(t);
      let e = hits.get(key);
      if (!e || e.resetAt <= t) { e = { count: 0, resetAt: t + windowMs }; hits.set(key, e); }
      e.count++;
      return e.count <= limit;
    },
    blocked(key) {
      const e = hits.get(key);
      return !!e && e.resetAt > now() && e.count >= limit;
    },
    retryAfterMs(key) {
      const e = hits.get(key);
      return e ? Math.max(0, e.resetAt - now()) : 0;
    },
  };
}

// Invisible / direction-changing characters used to spoof names.
const DECEPTIVE_CHARS = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/;

module.exports = { ipKey, clientIp, lastHop, originAllowed, createWindowLimiter, DECEPTIVE_CHARS };
