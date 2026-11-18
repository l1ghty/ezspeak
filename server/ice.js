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

function buildIceServers(iceCfg, userId, now = Date.now()) {
  const servers = [];
  if (iceCfg.stunUrls.length) servers.push({ urls: iceCfg.stunUrls.slice() });
  if (iceCfg.turnUrls.length) {
    if (iceCfg.turnSecret) {
      const { username, credential } = turnRestCredentials(iceCfg.turnSecret, userId, iceCfg.turnTtlSec, now);
      servers.push({ urls: iceCfg.turnUrls.slice(), username, credential });
    } else if (iceCfg.turnUsername && iceCfg.turnCredential) {
      servers.push({ urls: iceCfg.turnUrls.slice(), username: iceCfg.turnUsername, credential: iceCfg.turnCredential });
    }
  }
  return servers;
}

module.exports = { turnRestCredentials, buildIceServers };
