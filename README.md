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

```bash
docker compose up --build
```

Exposes port **3111**. With the optional TURN relay (needed for the IP-hiding mode, and it also makes connections work behind strict NATs):

```bash
TURN_SECRET=$(openssl rand -hex 32) \
TURN_URLS="turn:your.host:3478?transport=udp,turn:your.host:3478?transport=tcp" \
docker compose --profile turn up -d --build
```

Open UDP+TCP 3478 and UDP 49160–49200 on the host. If the host sits behind NAT, add `--external-ip=<public-ip>` to the coturn command.

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
| `TRUST_PROXY` | false | Use `X-Forwarded-For` as client IP (set when behind Coolify/Traefik/nginx) |
| `DISCONNECT_GRACE_MS` | 30000 | How long a dropped user is kept so a reconnect resumes the same session |

### Voice / relay

| Variable | Default | Meaning |
|----------|---------|---------|
| `STUN_URLS` | Google STUN | Comma-separated STUN URLs (empty string = none) |
| `TURN_URLS` | — | Comma-separated TURN URLs |
| `TURN_SECRET` | — | coturn `static-auth-secret`; clients get short-lived credentials |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | — | Alternative: fixed TURN credentials |
| `TURN_TTL` | 86400 | Lifetime of generated TURN credentials (seconds) |
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

## Testing

```bash
npm test            # unit + WebSocket integration tests (node:test, no browser)
npm run test:e2e    # Playwright: real Chromium peers with fake microphones
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
| `error` | `code`, `message` | e.g. `SERVER_FULL`, `SERVER_LIMIT`, `SERVER_LIMIT_IP`, `CHANNEL_FULL`, `CHANNEL_LIMIT`, `NOT_CREATOR`, `RELAY_UNAVAILABLE`, `RECONNECT_FAILED` |

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
