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

Exposes port **3111**.

## Features

- **WebRTC full mesh** — every peer connects directly to every other peer in a channel. Browser natively mixes multiple audio streams.
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
- **Creator tools** — add channels, set/remove server password
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

### Server (`server.js`)

| Directory | Concern |
|-----------|---------|
| `server.js` | HTTP server, Express static files, WebSocket upgrade |
| `server/state.js` | In-memory state: servers, channels, users, broadcasting |
| `server/handlers.js` | Per-message-type handler functions |

State is purely in-memory. No database. Servers persist as long as at least one user is connected.

### Client (`public/`)

| File | Concern |
|------|---------|
| `index.html` | Page structure, modals, control bar |
| `style.css` | Dark theme, layout, animations |
| `js/config.js` | Constants (RTC config, localStorage keys) |
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
| `join-server` | `serverName`, `username`, `password?` | Creates or joins server |
| `join-channel` | `channelName` | Auto-leaves current |
| `leave-channel` | — | Closes all WebRTC |
| `add-channel` | `channelName` | Creator only |
| `change-username` | `username` | Broadcasts to all |
| `set-password` | `password` | Creator only, empty = remove |
| `chat-message` | `message` | Broadcasts to channel |
| `mute-state-changed` | `value` | Self mute toggle (boolean) |
| `deafen-state-changed` | `value` | Self deafen toggle (boolean) |
| `webrtc-offer` | `targetId`, `offer` | SDP offer |
| `webrtc-answer` | `targetId`, `answer` | SDP answer |
| `webrtc-ice-candidate` | `targetId`, `candidate` | ICE candidate |

### Server → Client

| Type | Fields | Notes |
|------|--------|-------|
| `server-state` | `serverName`, `creator`, `hasPassword`, `channels`, `users`, `yourUserId` | Full state on join. Users include `isMuted`/`isDeafened`. |
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
| `webrtc-offer` | `fromId`, `fromUsername`, `offer` | Relayed offer |
| `webrtc-answer` | `fromId`, `fromUsername`, `answer` | Relayed answer |
| `webrtc-ice-candidate` | `fromId`, `fromUsername`, `candidate` | Relayed ICE |
| `error` | `message` | Error feedback |

## WebRTC Mesh Topology

When a user joins a channel:

1. Server notifies all existing peers via `peer-joined-channel` → each creates an `RTCPeerConnection` + SDP offer
2. New peer receives offers via `webrtc-offer` → creates answers
3. Bidirectional audio flows after ICE completes

With N users in a channel, each user has N−1 peer connections. All audio streams are played through `<audio>` elements and mixed natively by the browser.

### Volume & Mute

Per-peer volume uses `audio.volume` with an exponential slider curve (`Math.pow(x, 1.5)`) for natural perceptual range. Per-peer mute sets `audio.muted`. Global deafen overrides both.

### Per-user Controls

Each remote user in the channel list has:
- **Volume slider** (0–100%, exponential curve)
- **Mute button** (🔊/🔇) — stops audio from that specific user

Self mute (🤐) and deafen (🙉) status is broadcast to all channel members and persisted on the server so it survives page reloads.
