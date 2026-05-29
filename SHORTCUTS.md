# iOS Shortcuts

wklej.net can be opened from iOS Shortcuts through fragment URLs. Fragment values after `#` stay in the browser and are not sent to the Worker in the first page request.

## Ready iOS shortcut

This repo includes four signed iOS shortcuts:

```text
shortcuts/wklej-share-ios.shortcut
shortcuts/wklej-wait-share-ios.shortcut
shortcuts/wklej-create-ios.shortcut
shortcuts/wklej-join-ios.shortcut
```

Install on iPhone/iPad:

0. If you already imported an older `wklej` shortcut, delete it from the Shortcuts app first. iOS does not update imported `.shortcut` files automatically.
1. Send the `.shortcut` files to the device with AirDrop, iCloud Drive, or Files.
2. Open each file on iOS and add it to Shortcuts.
3. Reliable room-only flow: sender runs `wklej create`, receiver runs `wklej join`, both enter the same room name.
4. Small Share Sheet flow for tiny payloads: sender uses Share -> `wklej share`, enters a room name, and Safari opens once with the room command plus local payload.
5. Reliable Share Sheet flow: sender uses Share -> `wklej wait share`. It opens a short room URL first, waits until the browser reports that E2EE/DataChannel is ready, then hands off the shared item through `/shortcut-attach`.
6. The queued payload sends only after WebRTC and browser E2EE are ready.

Regenerate the signed shortcut from this repo:

```bash
python3 scripts/generate-ios-shortcut.py
```

The generated Share Sheet shortcut is intentionally small and serverless. It opens Safari once with the room command in query params and the shared item in a URL fragment, so the payload stays in Safari and is never sent to the Worker. Use it for small text/files only. If iOS refuses to encode a file, use `wklej create` and add the file from the in-browser attachment button after the peer is connected.

`wklej wait share` is the recommended iOS Share Sheet flow. The first URL is short and creates the room, so Safari should open the waiting room reliably. The Shortcut then calls `/api/shortcut-wait` and only opens `/shortcut-attach` after the browser marks the E2EE/DataChannel session as ready. The service worker returns `204 No Content`, keeps the WebRTC tab visible, and retries delivery briefly if the session is not connected yet.

## Receive / create room

Use the Shortcut action `Open URLs` with:

```text
https://wklej.net/?shortcut=create&room=deskdrop
```

The page creates a named room and waits for the peer.

## Join room

Use `Open URLs` with:

```text
https://wklej.net/?shortcut=join&room=deskdrop
```

The page joins an already waiting room.

## Send text after joining

URL-encode the text in Shortcuts, then open:

```text
https://wklej.net/#shortcut=join&room=deskdrop&text=URL_ENCODED_TEXT
```

After E2EE is ready, the text is sent over the DataChannel. Long text follows the normal app rule and becomes a `.txt` attachment.

## Files

iOS Shortcuts can pass a small shared file without server storage by embedding base64 in the URL fragment. The browser turns it back into a local `File`, creates the room, waits for the peer, then sends the file only after E2EE/DataChannel is ready.

Use this only for small files. The app accepts up to 6 MB from Shortcut fragments, but iOS may reject very long URLs earlier. Larger files still need manual attach in the browser UI, a native Share Extension, or a future supported Web Share Target flow.

Shortcut shape:

```text
Receive Share Sheet input
Save Shortcut Input as variable "shared"
Get Name of "shared"
Base64 Encode "shared" with no line breaks
URL Encode Base64 result
Open URL:
https://wklej.net/?shortcut=create&room=deskdrop#filename=URL_ENCODED_NAME&mime=application/octet-stream&file=URL_ENCODED_BASE64
```

The receiver joins with:

```text
https://wklej.net/?shortcut=join&room=deskdrop
```

Aliases accepted by the app:

- file data: `file`, `fileB64`, `b64`, `data`
- filename: `filename`, `fileName`, `title`
- MIME type: `mime`, `type`

## macOS helper apps

This repo installs two local helper apps in `~/Applications`:

- `wklej share.app` - drag a file onto it, choose a room name, and it creates a room with the file queued.
- `wklej join.app` - enter the same room name to join from another browser/device.

The macOS share helper does not put the whole file into the URL. It starts a temporary localhost server on `127.0.0.1`, opens:

```text
https://wklej.net/?localHandoff=1#shortcut=create&room=ROOM&handoff=TOKEN&handoffUrl=http://127.0.0.1:PORT/TOKEN
```

Then the browser fetches the file from localhost with the one-time token. The `localHandoff=1` query flag only enables the localhost CSP exception for this launch; the token and handoff URL stay in the fragment and are not sent to the Worker. The file still does not go to the Worker or Durable Object; it waits locally and sends only after E2EE/DataChannel is ready.

Recreate helpers:

```bash
chmod +x scripts/wklej-macos-share.sh scripts/wklej-macos-join.sh
osacompile -o "$HOME/Applications/wklej share.app" /path/to/wklej-share.applescript
osacompile -o "$HOME/Applications/wklej join.app" /path/to/wklej-join.applescript
```
