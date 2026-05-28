# Security model

wklej.net is an ephemeral WebRTC transfer app. The Worker and Durable Object are signaling-only for application payload.

## Payload confidentiality

- Each DataChannel session creates fresh browser-side ECDH P-256 keys.
- HKDF-SHA-256 derives an AES-GCM-256 payload key and the three-dot SAS pattern.
- Text, file metadata, previews and file chunks are encrypted before entering the DataChannel.
- E2EE keys are non-extractable where WebCrypto allows it and are never sent to Worker, Durable Object or TURN.

## Connectivity privacy

Default mode is direct-first for speed. If direct WebRTC cannot open the channel, both peers renegotiate through relay-only TURN instead of using mixed direct/relay candidates.

Relay-only fallback is fail-closed: if TURN credentials are unavailable, the fallback attempt does not silently downgrade to mixed direct candidates. Payload remains app-layer encrypted before it reaches the DataChannel.

## Server-side limits

- Room tokens are opaque AES-GCM sealed values; room keys are not returned to browsers.
- `/api/end` requires a participant `endKey` issued only to accepted sockets.
- `/api/ice`, `/api/tree`, `/api/session`, named-room APIs, WebSocket create/join and `/api/end` are rate limited.
- Durable Objects enforce exactly one seed and one peer per room; peer overflow terminates the room.

## Browser build trust

- Browser assets use content-addressed filenames and immutable caching.
- `index.html` includes SRI for the CSS and JS entrypoints.
- `/build-manifest.json` lists SHA-256/SHA-384 hashes for the generated browser surface.
- The client hashes its own CSS/JS entrypoints on startup and blocks pairing if they do not match the manifest.
- The short build fingerprint is visible in the UI and is exchanged during the E2EE handshake; peers must report the same build.
- Optional Ed25519 signing is supported, but production builds should prefer `ECDSA-P256-SHA256` for broad browser WebCrypto compatibility. Provide the key through `BUILD_MANIFEST_ECDSA_P256_PRIVATE_KEY_PEM`, `BUILD_MANIFEST_ECDSA_P256_PRIVATE_KEY_PEM_B64URL`, `BUILD_MANIFEST_ED25519_PRIVATE_KEY_PEM` or `BUILD_MANIFEST_ED25519_PRIVATE_KEY_PEM_B64URL`. Keep the private key outside the repository.

## Known privacy boundary

WebRTC signaling necessarily contains SDP/ICE metadata. In direct mode, peers may learn network candidate metadata. Relay-only fallback reduces peer-to-peer IP exposure when direct connection is unavailable, but it may be slower and still depends on browser ICE behavior.

Browser E2EE cannot perfectly solve malicious browser extensions or a fully compromised origin serving a malicious HTML bootstrap. The build fingerprint and manifest checks reduce CDN/supply-chain mistakes and make selective per-device frontend injection visible when both peers compare the same build fingerprint.
