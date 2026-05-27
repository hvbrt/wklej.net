# Deploy Checklist

## Offline Gate

```bash
npm install
npm run typecheck
npm run build
```

Expected:

- `typecheck` exits `0`.
- `build` runs `build:public` and `wrangler deploy --dry-run --outdir dist`.
- Wrangler prints bindings for `env.ROOM`, `env.RATELIMIT` and `env.ASSETS`.
- `public/` contains only generated opaque assets and `index.html`.

## Atlas Gate

```bash
node -e "const m=require('fs').readFileSync('worker/atlas.ts','utf8');const s=m.indexOf('export const ATLAS');const eq=m.indexOf('=',s);const a=JSON.parse(m.slice(m.indexOf('[',eq),m.lastIndexOf(']')+1));if(a.length!==1024)throw new Error('atlas != 1024');if(typeof a[0].id!=='number'||typeof a[0].symbol!=='string')throw new Error('bad schema');console.log('atlas OK',a.length)"
```

If it fails, run:

```bash
npm run build:atlas
npm run build
```

## Required Secret

`ROOM_PEPPER` must exist in Cloudflare:

```bash
npx wrangler secret list | grep -q ROOM_PEPPER
```

Do not commit `.dev.vars` or secret values.

## Deploy

```bash
npm run deploy
```

Expected:

- Upload succeeds.
- Output includes the Worker URL and custom domains.
- Bindings include `ROOM`, `RATELIMIT` and `ASSETS`.

## Production Smoke

```bash
DEPLOY_URL=https://wklej.net

curl -s "$DEPLOY_URL/api/tree?m1=&path=" | grep -q '"stage":"move"'
curl -s -o /dev/null -w "%{http_code}\n" "$DEPLOY_URL/" | grep -q 200
curl -s "$DEPLOY_URL/" | grep -Eq '/[0-9a-f]{10}\.(js|css)'
curl -s "$DEPLOY_URL/api/ice" | grep -q '"iceServers"'
curl -s "$DEPLOY_URL/api/ice" | grep -q '"mode"'
curl -sI "$DEPLOY_URL/" | grep -qi '^content-security-policy:'
curl -sI "$DEPLOY_URL/" | grep -qi '^x-content-type-options: nosniff'
```

Manual E2E:

- Open two tabs/devices.
- On both, drag the same first emoji onto the same grid cell.
- On both, choose the same next two emoji.
- Confirm seed and peer connect automatically after the second device completes the path.
- Confirm DataChannel text both ways.
- Confirm files transfer through the connected UI.
- Confirm no text/file payload uploads appear in Worker/API requests.
- Confirm `/api/end` rejects a token without the participant `endKey`.
- Refresh or close one connected tab and confirm the other tab immediately clears and reloads to the start screen.

Pairing TTL is 120 seconds and connected TTL is 120 seconds. Any peer close/refresh/glitch or TTL expiry destroys Durable Object state and forces cleanup + reload on every active participant page.

## Nearby Assist

Nearby assist is only a short-lived same-network hint. It never replaces the emoji proof and never grants access to a room by itself.

- If another device is detected, clicking it creates a seed room and sends an ephemeral invite with three emoji.
- Device names are browser-derived labels such as `iPhone Safari` or `Mac Chrome`, plus a short per-tab suffix; real OS device names are not exposed to the site.
- The invited device still has to click the shown emoji sequence in order.
- If Private Relay/VPN hides the network identity, or no device is found after a few polls, the UI switches to manual mode.
- Manual mode means both devices open `wklej.net` and choose the same emoji sequence.
