// ── ICE server list (STUN + TURN credentials) ───────────────────────────────

const crypto = require('crypto');

// coturn "TURN REST API" credentials: username = "<expiry>:<id>",
// credential = base64(HMAC-SHA1(secret, username)).
function turnRestCredentials(secret, id, ttlSec, now = Date.now()) {
  const expiry = Math.floor(now / 1000) + ttlSec;
  const username = `${expiry}:${id}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

// Hostname (without port) for a TURN URL; IPv6 stays bracketed.
function turnHostFrom(hostHeader) {
  if (typeof hostHeader !== 'string' || !hostHeader) return null;
  const h = hostHeader.trim().toLowerCase();
  const v6 = h.match(/^\[[0-9a-f:.]+\]/);
  if (v6) return v6[0];
  const name = h.split(':')[0];
  return /^[a-z0-9.-]+$/.test(name) ? name : null;
}

function fillHost(urls, host) {
  if (!urls.some(u => u.includes('{host}'))) return urls.slice();
  if (!host) return urls.filter(u => !u.includes('{host}'));
  return urls.map(u => u.split('{host}').join(host));
}

function buildIceServers(iceCfg, userId, now = Date.now(), host = null) {
  const servers = [];
  const turnUrls = fillHost(iceCfg.turnUrls, host);
  if (iceCfg.stunUrls.length) servers.push({ urls: iceCfg.stunUrls.slice() });
  if (turnUrls.length) {
    if (iceCfg.turnSecret) {
      const { username, credential } = turnRestCredentials(iceCfg.turnSecret, userId, iceCfg.turnTtlSec, now);
      servers.push({ urls: turnUrls, username, credential });
    } else if (iceCfg.turnUsername && iceCfg.turnCredential) {
      servers.push({ urls: turnUrls, username: iceCfg.turnUsername, credential: iceCfg.turnCredential });
    }
  }
  return servers;
}

module.exports = { turnRestCredentials, buildIceServers, turnHostFrom };
