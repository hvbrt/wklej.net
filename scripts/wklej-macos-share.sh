#!/usr/bin/env bash
set -euo pipefail

APP_URL="${WKLEJ_URL:-https://wklej.net/}"
MAX_BYTES="${WKLEJ_MACOS_SHARE_MAX_BYTES:-41943040}"

pick_file() {
  osascript -e 'POSIX path of (choose file with prompt "Choose a file to send with wklej.net")'
}

ask_room() {
  osascript -e 'text returned of (display dialog "Room name" default answer "macdrop" buttons {"Cancel", "Create"} default button "Create")'
}

show_error() {
  local message="$1"
  osascript -e "display dialog $(printf '%q' "$message") buttons {\"OK\"} default button \"OK\"" >/dev/null 2>&1 || true
}

FILE_PATH="${1:-}"
if [[ -z "$FILE_PATH" ]]; then
  FILE_PATH="$(pick_file)"
fi

if [[ ! -f "$FILE_PATH" ]]; then
  show_error "Selected item is not a file."
  exit 1
fi

ROOM_NAME="$(ask_room)"

python3 - "$APP_URL" "$MAX_BYTES" "$FILE_PATH" "$ROOM_NAME" <<'PY'
import base64
import json
import mimetypes
import os
import re
import secrets
import socket
import subprocess
import sys
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

app_url, max_bytes_raw, file_path, room_raw = sys.argv[1:5]
max_bytes = int(max_bytes_raw)

def normalize_room(raw):
    value = " ".join(raw.lower().strip().split())
    value = re.sub(r"[^a-z0-9._ -]+", "", value).strip()
    if len(value) < 4 or len(value) > 40:
        return ""
    if len(set(re.sub(r"[^a-z0-9]", "", value))) < 2:
        return ""
    return value

room = normalize_room(room_raw)
if not room:
    raise SystemExit("Room name must be 4-40 chars and non-obvious.")

size = os.path.getsize(file_path)
if size <= 0:
    raise SystemExit("File is empty.")
if size > max_bytes:
    raise SystemExit(f"File is too large for macOS handoff ({size} bytes, max {max_bytes} bytes).")

filename = os.path.basename(file_path)[:96] or "wklej-file.bin"
mime = mimetypes.guess_type(filename)[0] or ""
if not mime:
    try:
        mime = subprocess.check_output(["file", "-b", "--mime-type", file_path], text=True).strip()
    except Exception:
        mime = "application/octet-stream"
if not re.match(r"^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*$", mime, re.I):
    mime = "application/octet-stream"

with open(file_path, "rb") as fh:
    encoded = base64.b64encode(fh.read()).decode("ascii")

token = secrets.token_urlsafe(32)
served = {"done": False}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "https://wklej.net")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        if self.path.split("?", 1)[0] != f"/{token}":
            self.send_response(404)
            self.end_headers()
            return
        body = json.dumps({
            "type": "wklej-shortcut-file",
            "token": token,
            "filename": filename,
            "mime": mime,
            "file": encoded,
        }).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        served["done"] = True

with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]

handoff_url = f"http://127.0.0.1:{port}/{token}"
target = (
    app_url.rstrip("/")
    + "/?localHandoff=1#shortcut=create"
    + "&room=" + urllib.parse.quote(room)
    + "&handoff=" + urllib.parse.quote(token)
    + "&handoffUrl=" + urllib.parse.quote(handoff_url, safe="")
)

server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
subprocess.run(["open", target], check=False)

deadline = time.time() + 180
while time.time() < deadline and not served["done"]:
    server.handle_request()

server.server_close()
PY
