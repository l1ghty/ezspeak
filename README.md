# ezspeak

TeamSpeak-like voice chat in the browser. No downloads, no accounts. Just open a link and talk.

## Quick Start

```bash
npm install
npm start
# → http://localhost:3000
```

Share the link: `http://localhost:3000/server/my-crew`

## Features

- **WebRTC mesh** — every peer connects directly to every other peer in a channel
- **Channels** — default Lobby, Channel 1, Channel 2; creator can add more
- **Password-protected servers** — optional on creation, required on join
- **Text chat** — per-channel messages with join/leave system notices
- **Speaking indicators** — avatars glow green when audio is detected
- **Sound effects** — synthesized beeps for join, leave, and channel switch
- **Persistent identity** — username saved to localStorage (default: `ezhuman-chrome-4821`)
- **Recent servers** — modal with last 10 servers, accessible from all views
- **Mute / Deafen** — toggle mic mute and speaker mute
- **In-server rename** — change your display name live, everyone sees it
- **Creator tools** — add channels, set/remove server password

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
| `js/config.js` | Constants (RTC, localStorage keys) |
| `js/storage.js` | localStorage helpers (username, recent servers) |
| `js/audio.js` | Audio stream, mute/deafen, speaking detection, beeps |
| `js/net.js` | WebSocket signaling connection |
| `js/webrtc.js` | WebRTC mesh peer connections |
| `js/chat.js` | Chat message rendering |
| `js/ui.js` | DOM rendering, channel list, user list, modals |
| `js/app.js` | Entry point, state, routing, event wiring |

## WebSocket Protocol

All messages are JSON.

### Client → Server

| Type | Fields | Notes |
|------|--------|-------|
| `join-server` | `serverName`, `username`, `password?` | Creates or joins |
| `join-channel` | `channelName` | Auto-leaves current |
| `leave-channel` | — | Closes all WebRTC |
| `add-channel` | `channelName` | Creator only |
| `change-username` | `username` | Broadcasts to all |
| `set-password` | `password` | Creator only, empty = remove |
| `chat-message` | `message` | Broadcasts to channel |
| `webrtc-offer` | `targetId`, `offer` | SDP offer |
| `webrtc-answer` | `targetId`, `answer` | SDP answer |
| `webrtc-ice-candidate` | `targetId`, `candidate` | ICE candidate |

### Server → Client

| Type | Fields | Notes |
|------|--------|-------|
| `server-state` | `serverName`, `creator`, `hasPassword`, `channels`, `users`, `yourUserId` | Full state on join |
| `password-required` | `serverName` | Server needs a password |
| `user-joined-server` | `userId`, `username` | Another user joined |
| `user-left-server` | `userId` | Another user left |
| `user-renamed` | `userId`, `oldUsername`, `newUsername` | Name change |
| `password-updated` | `hasPassword` | Password set/removed |
| `user-channel-update` | `userId`, `username`, `channelName` | Moved channels |
| `channel-added` | `channelKey`, `channelName` | New channel |
| `joined-channel` | `channelName`, `existingPeers`, `peerDetails` | You joined |
| `left-channel` | `channelName` | You left |
| `peer-joined-channel` | `userId`, `username`, `channelName` | Another joined your channel |
| `peer-left-channel` | `userId`, `username`, `channelName` | Another left your channel |
| `chat-message` | `userId`, `username`, `message`, `timestamp` | Chat message |
| `webrtc-offer` | `fromId`, `fromUsername`, `offer` | Relayed offer |
| `webrtc-answer` | `fromId`, `fromUsername`, `answer` | Relayed answer |
| `webrtc-ice-candidate` | `fromId`, `fromUsername`, `candidate` | Relayed ICE |
| `error` | `message` | Error feedback |

## WebRTC Mesh Topology

When a user joins a channel:

1. Server notifies all existing peers → each creates an `RTCPeerConnection` + SDP offer
2. New peer receives offers → creates answers
3. Bidirectional audio flows after ICE completes

With N users in a channel, each user has N−1 peer connections. All audio streams are mixed natively by the browser.

## Docker

```bash
docker compose up --build
```

Exposes port **3111**.
