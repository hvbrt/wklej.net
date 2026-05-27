# wklej.net

Ephemeral WebRTC pairing on Cloudflare Workers + Durable Objects.

The Worker is signaling-only: rotating emoji-tree authorization, room availability,
SDP and ICE pass through Cloudflare, while text and file payloads travel only over
`RTCDataChannel`.

## Architecture

- Cloudflare Worker serves API routes and static assets.
- Durable Object stores one short-lived room state per concealed room key.
- WebSocket Hibernation keeps signaling sockets cheap and resumable.
- Durable Object Alarms enforce pairing and connected-session cleanup.
- Static assets and self-hosted fonts are served by Wrangler v4 `[assets]`, with no KV, D1 or R2.
- Frontend is vanilla JS + WebRTC, with no app framework or unused vendor JS.

## Flow

1. Browser requests `GET /api/tree` and renders a 30-second rotating 3-step emoji path.
2. The first move is spatial: drag one emoji onto one of 12 cells. The next two moves are clicks.
3. Browser posts `POST /api/session` with `{ m1:{id,pos}, path:[id,id], bucket }`.
4. Worker validates the path server-side, derives a concealed room key and returns only an opaque AES-GCM token.
5. Browser opens `/ws?token=...&role=seed|peer`; the Worker opens the token server-side and forwards the room key to the Durable Object via `X-Room-Key`.
6. Matching is implicit: the same emoji path resolves to the same Durable Object. The first accepted socket becomes seed, the second becomes peer.
7. After peer join, WebRTC starts immediately and the DataChannel carries messages and files peer-to-peer.
8. Pairing and connected phases each last up to 120 seconds. Bucket rotation affects only new pairing trees; existing Durable Object rooms keep their own `sessionNonce`, `roomKey`, `createdAt` and `expiresAt`. If either side refreshes, closes, glitches or the TTL expires, the room is destroyed and active pages clear local UI state and reload.

Room keys are never returned to the browser and are never placed in URLs. The browser does not compute or send client-side room hashes.

## Security Invariants

- A room reserves exactly one seed socket and at most one peer socket.
- `/api/end` requires a participant-only `endKey` issued over the accepted WebSocket; a freshly minted opaque token alone cannot destroy a room.
- WebRTC signaling is relayed only after the peer joins the same concealed room.
- The Worker relays only sanitized SDP/ICE frames, never text or file payloads.
- Emoji choices are not exchanged between browsers and are not stored as payload.
- Each pairing level is generated from a display-safe emoji atlas and rejects duplicate visible symbols inside one option set.
- Any session-side close, refresh, WebSocket error, DataChannel close/failure or TTL expiry triggers hard teardown: server-side destroy plus client-side cleanup and reload for every still-open participant page.
- Responses include security headers: CSP, no-referrer, nosniff, frame-ancestors deny, Permissions-Policy and HSTS on HTTPS.

## Frontend Build

Readable browser sources live in `client/`. `npm run build:public` minifies and content-hashes them into `public/`:

- one opaque CSS file, for example `/a4a9f5f53a.css`,
- one opaque app JS bundle,
- self-hosted, content-hashed WOFF2 font files,
- generated `index.html`.

Readable files such as `app.js`, `webrtc.js`, `emoji.js`, `app.css` and `emoji-atlas.json` are not served from `public/`.

## Secrets

`ROOM_PEPPER` is required in production. It derives concealed room keys and seals session tokens.

```bash
openssl rand -base64 32 | npx wrangler secret put ROOM_PEPPER
```

Keep it stable. Rotating it invalidates active tokens and active pairing rooms.

TURN is optional but recommended for cross-network reliability:

```bash
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_API_TOKEN
```

Create a Cloudflare Realtime TURN key in the Cloudflare dashboard or API, then store the returned TURN Token ID as `TURN_KEY_ID` and the returned API token/key as `TURN_KEY_API_TOKEN`. Without these secrets, `/api/ice` returns `"mode":"stun-fallback"` and works best on the same LAN/Wi-Fi.

## Development

```bash
npm install
npm run typecheck
npm run build
npm run dev
```

## Deploy

```bash
npm run deploy
```

Smoke checks:

```bash
curl -s 'https://wklej.net/api/tree?m1=&path=' | grep -q '"stage":"move"'
curl -s https://wklej.net/api/ice | grep -q '"iceServers"'
```

## Constraints

No payload relay, no persistent payload storage, no account system, no KV, no D1, no R2, no Socket.IO, no Firebase, no HTMX and no polling fallback.
