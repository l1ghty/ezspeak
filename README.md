# ezspeak

TeamSpeak-like voice chat in the browser. No downloads, no accounts. Just open a link and talk.

## Quick Start

```bash
npm install
npm start
# → http://localhost:3000
```
Share the link: `http://localhost:3000/server/my-crew`

## Docker Compose

Everything needed to run — ezspeak plus a TURN relay (coturn) — is in `docker-compose.yml`:

```bash
docker compose up -d --build
# → http://<host>:3111
```

No configuration is required:

- An `init` step generates a random TURN secret on first start and stores it in the `secrets` volume. ezspeak (`TURN_SECRET_FILE`) and coturn read it from there, and it survives restarts and rebuilds.
- Clients get TURN URLs for the hostname they opened the page on (`turn:<host>:3478`, UDP and TCP), with short-lived credentials.
- coturn refuses to relay into private networks (LAN, loopback, cloud metadata).

Open these ports on the host firewall: **3111/tcp** (web, unless a reverse proxy fronts it), **3478/udp+tcp** and **49160–49200/udp** (relay). coturn uses host networking, so it needs a Linux Docker host (not Docker Desktop).

Optional settings go into a `.env` file next to the compose file. See `.env.example` for the full list. The common ones:

| Variable | When |
|----------|------|
| `TRUST_PROXY=true` | Behind Coolify/Traefik/nginx (real client IPs for per-IP limits, public hostname for TURN URLs) |
| `TURN_EXTERNAL_IP=<ip>` or `auto` | The host is behind NAT (home server, some clouds) |
| `TURN_URLS=turn:turn.example.com:3478` | TURN is reachable under a different hostname than the web app (e.g. the app is behind a CDN/proxy that doesn't pass UDP) |
| `TURN_SECRET=...` | Use your own secret instead of the generated one |
| `TURN_ALLOW_LAN=true` | Testing on a LAN / one machine only |
| `FORCE_RELAY=true` | Hide every user's IP on every server |

## Configuration

All settings are environment variables (see `server/config.js`).

### Hosting limits

| Variable | Default | Meaning |
|----------|---------|---------|
| `MAX_SERVERS` | 100 | Servers (rooms) that may exist at once on this host |
| `MAX_SERVERS_PER_IP` | 5 | Servers one IP may have created at once (joining existing ones is unlimited) |
| `MAX_USERS_PER_SERVER` | 50 | Upper bound per server; the server's creator can set a lower limit |
| `MAX_USERS_PER_CHANNEL` | 10 | Upper bound per channel (full mesh: every user uploads to every other user, so keep this small); creator can lower it |
| `MAX_CHANNELS_PER_SERVER` | 20 | Channels per server, including the 3 defaults |
| `MAX_CONNECTIONS` | 500 | Open WebSockets in total |
| `MAX_CONNECTIONS_PER_IP` | 20 | Open WebSockets per client IP |
| `TRUST_PROXY` | false | `true` or number of reverse proxies in front (Coolify/Traefik/nginx). Only enable when the app isn't reachable directly |
| `ALLOWED_ORIGINS` | — | Extra origins allowed to open WebSockets (own origin always allowed) |
| `CONNECT_RATE_PER_IP` | 60 | New WebSocket connections per IP per minute |
| `PASSWORD_FAILS_PER_IP` | 10 | Wrong server passwords per IP per 10 minutes before lockout |
| `JOIN_TIMEOUT_MS` | 30000 | Connections that haven't joined a server by then are closed |
| `DISCONNECT_GRACE_MS` | 30000 | How long a dropped user is kept so a reconnect resumes the same session |

### Voice / relay

| Variable | Default | Meaning |
|----------|---------|---------|
| `STUN_URLS` | Google STUN | Comma-separated STUN URLs (empty string = none) |
| `TURN_URLS` | auto | Comma-separated TURN URLs; `{host}` is replaced by the page's hostname |
| `TURN_SECRET` / `TURN_SECRET_FILE` | — | coturn `static-auth-secret` (or a file containing it); clients get short-lived credentials. A secret alone enables TURN at `turn:<page host>:TURN_PORT` |
| `TURN_PORT` | 3478 | Port used for the automatic TURN URLs |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | — | Alternative: fixed TURN credentials |
| `TURN_TTL` | 21600 | Lifetime of generated TURN credentials (seconds); clients refresh at 80 % |
| `FORCE_RELAY` | false | Relay-only for every server on this host (all IPs hidden) |

## Privacy: hiding IP addresses

By default voice is peer-to-peer, which means everybody in a channel can see everybody else's IP address (that's how WebRTC works). ezspeak can route media through a TURN relay instead, so users only ever see the relay's address:

- **Per user** — ⚙️ Settings → *Hide my IP address*. Your browser only uses relay candidates and the server strips anything else you send.
- **Per server** — the creator opens 🛠️ *Server settings* → *Hide everyone's IP*. Applies to every member of that server.
- **Whole host** — `FORCE_RELAY=true`.

In relay mode the client only gathers TURN relay candidates (`iceTransportPolicy: 'relay'`), and the signaling server additionally drops every non-relay ICE candidate, blanks the related address (`raddr`) of relay candidates and the connection addresses in SDP before forwarding. The mode needs a TURN server; if none is configured the server refuses to enable it for a server, and a user who turned it on personally gets a clear warning instead of silently falling back to a direct connection. A 🛡️ badge in the channel header shows when relay mode is active.

### When the network blocks connections

Firewalls on company/school/public Wi-Fi, VPNs or strict NATs often block direct WebRTC traffic. ezspeak detects this and shows a warning dialog:

- **Voice link never connects** (ICE fails after restarts, or stays stuck while connecting): the dialog names the user you couldn't reach and, if the host has a TURN relay, offers **🛡️ Create relay room**, which opens a new relay-only room (`<room>-relay-xxxx`) with you as creator and opens the share dialog so you can send the new link. It also offers **Use relay just for me** (turns on the personal hide-my-IP setting). Without TURN on the host it explains that instead.
- **Even the relay fails**: suggests another network; no relay button.
- **The WebSocket can't be opened** (no server contact after 3 attempts): checks whether plain HTTP works to tell "WebSockets are filtered by a proxy/firewall" apart from "server unreachable". ezspeak keeps retrying and closes the dialog once it connects.

Links that were connected before and then drop don't trigger the warning (those get repaired automatically), and it's shown at most once every 5 minutes.

## Security & abuse protection

| Threat | Protection |
|--------|------------|
| Other websites using this server's signaling / TURN relay | WebSocket `Origin` must match the page's host (or `ALLOWED_ORIGINS`) |
| TURN relay used as a free proxy | Credentials only after joining a server and only valid for `TURN_TTL` (6 h, clients refresh automatically); coturn: no TCP relay, per-user allocation quota, per-session bandwidth cap, no relaying into private networks |
| Password brute force / CPU exhaustion | scrypt runs off the event loop; `PASSWORD_FAILS_PER_IP` wrong passwords per 10 min, then the IP is locked out |
| Connection flooding / squatting | Concurrent connections per IP, new connections per IP per minute, sockets that don't join within 30 s are closed |
| Message floods / bandwidth amplification | Per-socket byte budget (512 KB burst, 64 KB/s), message budgets, and tight per-type limits for broadcasts (chat, avatar, rename, file announcements, admin actions); avatars ≤ 24 KB, SDP ≤ 32 KB |
| Spoofed client IPs | `TRUST_PROXY` = number of proxies; only the proxy-appended (rightmost) `X-Forwarded-For` entries are trusted |
| IPv6 address rotation | Per-IP limits apply per /64 |
| Abusive users in a room | The server admin can remove a user (🚫); the IP is banned from that server for its lifetime |
| Name spoofing | Control, bidi-override and zero-width characters are rejected |
| Malicious file transfers | Only requested files are accepted, never more than the announced size; downloads are always `application/octet-stream` |
| XSS / clickjacking | Strict CSP (`script-src 'self'`, `frame-ancestors 'none'`, …), escaped output, `Permissions-Policy` |

## Testing

```bash
npm test            # unit + WebSocket integration tests (node:test, no browser)
npm run test:e2e    # Playwright: real Chromium peers with fake microphones
npm run test:stack  # builds the docker compose stack on side ports and checks
                    # real voice through coturn (needs Docker)
```

The E2E suite covers two- and three-user meshes (asserting audio bytes actually flow), channel switching, surviving a signaling drop, the network-blocked dialogs (simulated firewall and WebSocket-blocking proxy) including creating a relay room, page reloads, automatic healing of a broken peer connection, per-user volume/mute, channel capacity and the relay-only leak check. If your Playwright version's browser isn't installed, point it at any Chromium with `PW_CHROMIUM_PATH=/path/to/chrome`.

## Features

- **WebRTC full mesh** — every peer connects directly to every other peer in a channel. Browser natively mixes multiple audio streams.
- **Self-healing connections** — ICE restarts on network changes, automatic rebuild of broken links, session resume after signaling drops (voice keeps flowing while the WebSocket reconnects)
- **IP privacy mode** — optional TURN relay-only voice per user, per server or host-wide
- **Hosting limits** — caps for servers, users, channels and connections (global and per IP); creators can set per-server user/channel limits
- **Channels** — default Lobby, Channel 1, Channel 2; creator can add more
- **Password-protected servers** — optional on creation, required on join
- **Text chat** — per-channel messages with join/leave system notices
- **Speaking indicators** — avatars glow green when audio is detected (AnalyserNode threshold)
- **Per-user volume & mute** — volume slider (0–100%) and mute button per peer. Exponential curve for natural volume control.
- **Mute/Deafen status broadcast** — your mute 🤐 and deafen 🙉 state is visible to everyone in the channel. Persisted on the server (survives reloads).
- **Sound effects** — synthesized beeps for join, leave, and channel switch
- **Persistent identity** — username saved to localStorage (default: `ezhuman-chrome-4821`)
- **Recent servers** — modal with last 10 servers, accessible from all views
- **In-server rename** — change your display name live, everyone sees it
- **Creator tools** — add channels, password, user/channel limits, relay-only mode (handed to the next user if the creator leaves)
- **Mobile-optimized** — slide-out sidebar, 44px touch targets, WakeLock API
- **Autoplay recovery** — per-audio-element retry on user interaction

## Architecture

```
Browser A ←──WebRTC mesh──→ Browser B
    │                           │
    └────── WebSocket ──────────┘
                 │
          signaling server
           (Node.js / Express / ws)
```

### Server

| File | Concern |
|------|---------|
| `server.js` | Entry point: loads config, starts the app |
| `server/config.js` | Environment variables → typed config (limits, TURN, …) |
| `server/app.js` | `createApp(config)`: Express routes, WebSocket server, ping/idle handling |
| `server/state.js` | `createState(config)`: in-memory servers, channels, users, sockets, per-IP accounting |
| `server/handlers.js` | `createHandlers(state, config)`: message routing, rate limiting, signaling relay + sanitizing |
| `server/ice.js` | ICE server list and TURN REST credentials |

Everything is created through factories (no module-level state), so tests run many isolated instances in one process. State is purely in-memory. Servers persist as long as at least one user is connected (or within their reconnect grace period).

### Client (`public/`)

| File | Concern |
|------|---------|
| `index.html` | Page structure, modals, control bar |
| `style.css` | Dark theme, layout, animations |
| `js/shared.js` | Pure helpers shared with the server and unit tests (candidate/SDP filtering, negotiation decisions, backoff) |
| `js/config.js` | Constants (fallback RTC config, localStorage keys) |
| `js/storage.js` | localStorage helpers (username, recent servers) |
| `js/audio.js` | Audio stream, mute/deafen, speaking detection, beeps |
| `js/net.js` | WebSocket signaling connection, keep-alive |
| `js/webrtc.js` | WebRTC full-mesh peer connections, per-user volume/mute |
| `js/chat.js` | Chat message rendering |
| `js/ui.js` | DOM rendering, channel list, user list with controls, modals |
| `js/app.js` | Entry point, state, routing, signaling dispatch, event wiring |

## WebSocket Protocol

All messages are JSON.

### Client → Server

| Type | Fields | Notes |
|------|--------|-------|
| `join-server` | `serverName`, `username`, `password?`, `avatar?`, `relayOnly?`, `createRelayOnly?` | Creates or joins server. `createRelayOnly` makes a newly created server relay-only (refused with `RELAY_UNAVAILABLE` without TURN). |
| `reconnect-session` | `serverName`, `userId`, `reconnectToken`, `relayOnly?` | Resume a session after a dropped socket |
| `update-server-settings` | `maxUsers?`, `maxUsersPerChannel?`, `relayOnly?` | Creator only |
| `kick-user` | `userId` | Creator only: remove + ban (by IP) for the server's lifetime |
| `set-privacy` | `relayOnly` | Per-user "hide my IP" preference |
| `get-ice-servers` | — | Fresh ICE/TURN credentials |
| `join-channel` | `channelName` | Auto-leaves current |
| `leave-channel` | — | Closes all WebRTC |
| `disconnect` | — | Leave immediately (no grace period) |
| `ping` | — | Keep-alive, answered with `pong` |
| `add-channel` | `channelName` | Creator only |
| `change-username` | `username` | Broadcasts to all |
| `set-password` | `password` | Creator only, empty = remove |
| `chat-message` | `message` | Broadcasts to channel |
| `mute-state-changed` | `value` | Self mute toggle (boolean) |
| `deafen-state-changed` | `value` | Self deafen toggle (boolean) |
| `webrtc-offer` | `targetId`, `connId`, `offer` | SDP offer |
| `webrtc-answer` | `targetId`, `connId`, `answer` | SDP answer |
| `webrtc-ice-candidate` | `targetId`, `connId`, `candidate` | ICE candidate |

### Server → Client

| Type | Fields | Notes |
|------|--------|-------|
| `server-state` | `serverName`, `creator`, `hasPassword`, `relayOnly`, `forceRelay`, `relayAvailable`, `maxUsers`, `maxUsersPerChannel`, `limits`, `channels`, `users`, `yourUserId`, `reconnectToken`, `iceServers`, `reconnected?` | Full state on join/resume. Users include `isMuted`/`isDeafened`. |
| `server-settings-updated` | same settings fields as above | Creator changed settings |
| `creator-changed` | `creator` | Previous creator left |
| `kicked` | `serverName` | You were removed (socket then closes with 4003) |
| `user-kicked` | `userId`, `username` | Someone was removed |
| `password-required` | `serverName` | Server needs a password |
| `user-joined-server` | `userId`, `username` | Another user joined |
| `user-left-server` | `userId` | Another user left |
| `user-renamed` | `userId`, `oldUsername`, `newUsername` | Name change |
| `password-updated` | `hasPassword` | Password set/removed |
| `user-channel-update` | `userId`, `username`, `channelName` | Moved channels |
| `channel-added` | `channelKey`, `channelName` | New channel |
| `joined-channel` | `channelName`, `existingPeers`, `peerDetails`, `totalUsers` | You joined. `peerDetails` includes mute/deafen state. |
| `left-channel` | `channelName` | You left |
| `peer-joined-channel` | `userId`, `username`, `channelName`, `totalUsers`, `isMuted`, `isDeafened` | Another joined your channel |
| `peer-left-channel` | `userId`, `username`, `channelName` | Another left your channel |
| `mute-state-changed` | `userId`, `username`, `value` | Peer mute state changed |
| `deafen-state-changed` | `userId`, `username`, `value` | Peer deafen state changed |
| `chat-message` | `userId`, `username`, `message`, `timestamp` | Chat message |
| `webrtc-offer` | `fromId`, `fromUsername`, `connId`, `offer` | Relayed offer |
| `webrtc-answer` | `fromId`, `fromUsername`, `connId`, `answer` | Relayed answer |
| `webrtc-ice-candidate` | `fromId`, `fromUsername`, `connId`, `candidate` | Relayed ICE (filtered in relay mode) |
| `error` | `code`, `message` | e.g. `SERVER_FULL`, `SERVER_LIMIT`, `SERVER_LIMIT_IP`, `BANNED`, `TOO_MANY_ATTEMPTS`, `RATE_LIMITED`, `TRY_AGAIN`, `CHANNEL_FULL`, `CHANNEL_LIMIT`, `NOT_CREATOR`, `RELAY_UNAVAILABLE`, `RECONNECT_FAILED` |

## WebRTC Mesh Topology

When a user joins a channel:

1. The joiner receives `joined-channel` with the existing peers and sends each of them an offer (one initiator per pair, no races).
2. Every offer/answer/candidate carries a `connId` identifying one RTCPeerConnection session. If a peer comes back with a new `connId` (reload, rebuilt link) the other side replaces its stale connection instead of mixing two sessions; if both sides start a new session at the same time the higher `connId` wins on both ends.
3. Renegotiation (camera/screen share) uses the *perfect negotiation* pattern; the side that did not create the session is "polite". All incoming signaling for a peer is processed strictly in order.
4. Health: ICE `disconnected` gets a short grace period, then an ICE restart (twice), then a fresh session. A watchdog every few seconds connects to channel members we have no working link to. After a WebSocket drop the session is resumed with a token; peer connections keep running during the outage and only broken links are rebuilt.

With N users in a channel, each user has N−1 peer connections, which is why the per-channel limit defaults to 10.

### Volume & Mute

Per-peer volume uses `audio.volume` with an exponential slider curve (`Math.pow(x, 1.5)`) for natural perceptual range. Per-peer mute sets `audio.muted`. Global deafen overrides both.

### Per-user Controls

Each remote user in the channel list has:
- **Volume slider** (0–100%, exponential curve)
- **Mute button** (🔊/🔇) — stops audio from that specific user

Self mute (🤐) and deafen (🙉) status is broadcast to all channel members and persisted on the server so it survives page reloads.
