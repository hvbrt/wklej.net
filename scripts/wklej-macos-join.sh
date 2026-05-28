#!/usr/bin/env bash
set -euo pipefail

APP_URL="${WKLEJ_URL:-https://wklej.net/}"

ROOM_NAME="$(osascript -e 'text returned of (display dialog "Room name to join" default answer "macdrop" buttons {"Cancel", "Join"} default button "Join")')"

python3 - "$APP_URL" "$ROOM_NAME" <<'PY'
import re
import subprocess
import sys
import urllib.parse

app_url, room_raw = sys.argv[1:3]
room = " ".join(room_raw.lower().strip().split())
room = re.sub(r"[^a-z0-9._ -]+", "", room).strip()
if len(room) < 4 or len(room) > 40 or len(set(re.sub(r"[^a-z0-9]", "", room))) < 2:
    raise SystemExit("Bad room name.")

target = app_url.rstrip("/") + "/#shortcut=join&room=" + urllib.parse.quote(room)
subprocess.run(["open", target], check=False)
PY
