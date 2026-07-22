// Orchestrator: rotating emoji-tree pairing, signaling WS, and P2P editor.
// Browser-visible state is limited to the chosen emoji path and opaque token;
// room keys stay server-side, payload stays on the WebRTC DataChannel.

(function () {
  const $ = (id) => document.getElementById(id);
  const MAX_FILE = 100 * 1024 * 1024;
  const LONG_TEXT_LIMIT = 200;
  const SESSION_SECONDS = 120;
  const SESSION_EXTEND_SECONDS = 120;
  const SESSION_EXTEND_WINDOW_SECONDS = 10;
  const GRACE_PROMPT_SECONDS = 5;
  const GRACE_EXTEND_SECONDS = 10;

  const screens = {};
  document.querySelectorAll("[data-screen]").forEach((el) => (screens[el.dataset.screen] = el));
  function show(name) {
    for (const k in screens) screens[k].hidden = k !== name;
  }

  const currentScriptPath = document.currentScript ? new URL(document.currentScript.src).pathname : "";
  const stylesheetPath = document.querySelector('link[rel="stylesheet"]')?.href
    ? new URL(document.querySelector('link[rel="stylesheet"]').href).pathname
    : "";
  const BUILD_INFO = {
    fingerprint: document.documentElement.dataset.buildFingerprint || "",
    hash: document.documentElement.dataset.buildHash || "",
    signed: document.documentElement.dataset.buildSigned === "true",
    publicKey: document.documentElement.dataset.buildPublicKey || "",
    appPath: currentScriptPath,
    cssPath: stylesheetPath,
  };
  let buildReady = null;
  let buildVerified = false;
  let buildFailed = false;

  function setBuildStatus(text, cls) {
    const line = document.querySelector(".build-line");
    const stateEl = $("build-state");
    const fpEl = $("build-fingerprint");
    if (line) line.className = `build-line ${cls || ""}`.trim();
    if (stateEl) stateEl.textContent = text;
    if (fpEl) fpEl.textContent = BUILD_INFO.fingerprint || "----";
    const badge = $("build-badge");
    if (badge) badge.textContent = BUILD_INFO.fingerprint ? `build ${BUILD_INFO.fingerprint}` : "build";
  }

  async function verifyBuildSurface() {
    setBuildStatus("checking build", "warn");
    const res = await fetch("/build-manifest.json", { cache: "no-store" });
    if (!res.ok) throw new Error("missing build manifest");
    const manifest = await res.json();
    if (!manifest || manifest.version !== 1 || !manifest.build || !manifest.assets) throw new Error("bad build manifest");
    if (manifest.build.fingerprint !== BUILD_INFO.fingerprint || manifest.build.sha256 !== BUILD_INFO.hash) {
      throw new Error("build fingerprint mismatch");
    }
    await verifyManifestSignature(manifest);
    await Promise.all([
      verifyPublicAsset(manifest, BUILD_INFO.appPath),
      verifyPublicAsset(manifest, BUILD_INFO.cssPath),
    ]);
    setBuildStatus(manifest.signature && manifest.signature.alg !== "none" ? "signed build" : "build verified", "ok");
  }

  async function verifyPublicAsset(manifest, path) {
    const name = String(path || "").replace(/^\//, "");
    const expected = manifest.assets[name];
    if (!expected || !expected.sha256) throw new Error(`missing manifest asset: ${name}`);
    const res = await fetch(path, { cache: "force-cache" });
    if (!res.ok) throw new Error(`asset unavailable: ${name}`);
    const actual = await sha256Hex(await res.arrayBuffer());
    if (actual !== expected.sha256) throw new Error(`asset hash mismatch: ${name}`);
  }

  async function verifyManifestSignature(manifest) {
    const sig = manifest.signature;
    if (!sig || sig.alg === "none") return false;
    if (!["Ed25519", "ECDSA-P256-SHA256"].includes(sig.alg) || typeof sig.key !== "string" || typeof sig.value !== "string") {
      throw new Error("bad manifest signature metadata");
    }
    if (BUILD_INFO.publicKey && sig.key !== BUILD_INFO.publicKey) throw new Error("manifest signing key mismatch");
    const keyBytes = b64urlBytes(sig.key);
    const sigBytes = b64urlBytes(sig.value);
    const payload = { ...manifest };
    delete payload.signature;
    const data = new TextEncoder().encode(stableStringify(payload));
    const ok =
      sig.alg === "Ed25519"
        ? await verifyEd25519Signature(keyBytes, sigBytes, data)
        : await verifyEcdsaP256Signature(keyBytes, sigBytes, data);
    if (!ok) throw new Error("manifest signature mismatch");
    return true;
  }

  async function verifyEd25519Signature(keyBytes, sigBytes, data) {
    const key = await crypto.subtle.importKey("spki", keyBytes, { name: "Ed25519" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "Ed25519" }, key, sigBytes, data);
  }

  async function verifyEcdsaP256Signature(keyBytes, sigBytes, data) {
    const key = await crypto.subtle.importKey("spki", keyBytes, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sigBytes, data);
  }

  async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function b64urlBytes(value) {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  }

  function blockUnverifiedBuild() {
    buildFailed = true;
    setBuildStatus("build blocked", "bad");
    document.querySelectorAll(".pair-action").forEach((btn) => {
      btn.disabled = true;
    });
    const grid = $("emoji-grid");
    if (grid) {
      grid.textContent = "build verification failed";
      grid.classList.add("grid-loading");
    }
  }

  async function requireVerifiedBuild() {
    if (buildVerified) return true;
    if (buildFailed) return false;
    try {
      await buildReady;
      return buildVerified;
    } catch {
      return false;
    }
  }

  function setLoading(text, quiet) {
    const silent = quiet === true || state.nearbySend;
    const title = $("loading-text");
    const pick = $("your-pick");
    title.hidden = silent;
    pick.hidden = silent;
    title.textContent = silent ? "" : text;
  }

  const state = {
    token: "",
    endKey: "",
    label: "",
    selection: null,
    role: null,
    ws: null,
    mode: null,
    connected: false,
    ending: false,
    notifiedEnd: false,
    retrying: false,
    timers: [],
    theme: null,
    nearbySend: false,
    pendingPayload: null,
    shortcutCallback: "",
    attachmentNavSafe: false,
  };

  let pendingReset = null;
  let graceCountdownInterval = 0;
  let graceCountdownTimeout = 0;
  let graceExtendInterval = 0;
  let graceExtendTimeout = 0;
  let graceExtensionUsed = false;
  let sessionCountdownTimer = 0;
  let sessionExtendUsed = false;
  let lastTransportKind = "";
  let shortcutHandoffToken = "";
  const SHORTCUT_PAYLOAD_CHANNEL = "wklej-shortcut-payload-v1";
  const SHORTCUT_PAYLOAD_STORAGE = "wklej-shortcut-payload-v1";
  const seenShortcutPayloads = new Set();
  let shortcutPayloadChannel = null;
  let shortcutPayloadPollTimer = 0;
  let shortcutServiceWorkerReady = Promise.resolve(false);

  function clearTimers() {
    state.timers.forEach((t) => {
      clearInterval(t);
      clearTimeout(t);
    });
    state.timers = [];
    clearSessionCountdown();
  }

  function countdown(elId, secs, onEnd) {
    const el = $(elId);
    if (!el) return;
    let left = secs;
    el.textContent = String(left);
    const t = setInterval(() => {
      left -= 1;
      el.textContent = String(Math.max(0, left));
      if (left <= 0) {
        clearInterval(t);
        onEnd && onEnd();
      }
    }, 1000);
    state.timers.push(t);
  }

  function clearSessionCountdown() {
    clearInterval(sessionCountdownTimer);
    sessionCountdownTimer = 0;
    hideSessionExtend();
  }

  function hideSessionExtend() {
    const btn = $("session-extend");
    if (!btn) return;
    btn.hidden = true;
    btn.disabled = false;
  }

  function setSessionTime(left) {
    const cd = $("cd-conn");
    if (cd) cd.textContent = String(Math.max(0, left));
  }

  function startConnectedCountdown(seconds) {
    clearSessionCountdown();
    let left = Math.max(0, Math.ceil(seconds));
    setSessionTime(left);
    updateSessionExtendButton(left);
    sessionCountdownTimer = setInterval(() => {
      left -= 1;
      setSessionTime(left);
      updateSessionExtendButton(left);
      if (left <= 0) {
        clearSessionCountdown();
        hardReset("expired", true);
      }
    }, 1000);
  }

  function updateSessionExtendButton(left) {
    const btn = $("session-extend");
    if (!btn) return;
    const canExtend = state.connected && !state.ending && !sessionExtendUsed && left > 0 && left <= SESSION_EXTEND_WINDOW_SECONDS;
    btn.hidden = !canExtend;
    btn.disabled = false;
  }

  function requestSessionExtend() {
    const btn = $("session-extend");
    if (!state.connected || state.ending || sessionExtendUsed) return;
    sessionExtendUsed = true;
    if (btn) {
      btn.hidden = true;
      btn.disabled = true;
    }
    clearInterval(sessionCountdownTimer);
    sessionCountdownTimer = 0;
    setSessionTime(SESSION_EXTEND_SECONDS);
    wsSend({ type: "extend-session" });
  }

  function applySessionExtended(expiresAt) {
    const ms = typeof expiresAt === "number" ? expiresAt - Date.now() : SESSION_EXTEND_SECONDS * 1000;
    sessionExtendUsed = true;
    startConnectedCountdown(Math.max(1, Math.ceil(ms / 1000)));
  }

  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
    return (n / 1073741824).toFixed(2) + " GB";
  }

  function isTheme(value) {
    return (
      Array.isArray(value) &&
      value.length === 3 &&
      value.every((v) => typeof v === "string" && /^\d{1,3} \d{1,3}% \d{1,3}%$/.test(v))
    );
  }

  function applySessionTheme() {
    const panel = screens.connected;
    if (!panel || !isTheme(state.theme)) return;
    panel.style.setProperty("--session-a", state.theme[0]);
    panel.style.setProperty("--session-b", state.theme[1]);
    panel.style.setProperty("--session-c", state.theme[2]);
    panel.classList.add("session-themed");
  }

  function clearSessionTheme() {
    const panel = screens.connected;
    if (!panel) return;
    panel.classList.remove("session-themed");
    panel.style.removeProperty("--session-a");
    panel.style.removeProperty("--session-b");
    panel.style.removeProperty("--session-c");
  }

  function setDotPattern(el, colors) {
    if (!el || !isTheme(colors)) return;
    Array.from(el.querySelectorAll("span")).forEach((dot, index) => {
      dot.style.setProperty("--dot", colors[index]);
    });
    el.hidden = false;
  }

  function clearSafetyDots() {
    const dots = $("session-dots");
    if (!dots) return;
    dots.hidden = true;
    Array.from(dots.querySelectorAll("span")).forEach((dot) => dot.style.removeProperty("--dot"));
  }

  function applySafetyDots(colors) {
    setDotPattern($("session-dots"), colors);
  }

  function randomDotPattern() {
    const bytes = new Uint8Array(9);
    crypto.getRandomValues(bytes);
    const base = bytes[0] % 360;
    return [
      `${base} ${72 + (bytes[1] % 18)}% ${42 + (bytes[2] % 14)}%`,
      `${(base + 115 + (bytes[3] % 46)) % 360} ${70 + (bytes[4] % 20)}% ${44 + (bytes[5] % 14)}%`,
      `${(base + 222 + (bytes[6] % 44)) % 360} ${72 + (bytes[7] % 18)}% ${46 + (bytes[8] % 12)}%`,
    ];
  }

  function seedWaitText() {
    if (state.selection && state.selection.named) return state.selection.name || state.label.replace(/^(create|join):\s*/i, "");
    return state.label;
  }

  function applySeedWaitLabel() {
    const el = $("seed-label");
    if (!el) return;
    const named = !!(state.selection && state.selection.named);
    el.textContent = seedWaitText();
    el.classList.toggle("wait-name", named);
    el.classList.toggle("wait-emoji", !named);
  }

  // ---------- Pairing session ----------
  function beginPairing() {
    state.mode = "pairing";
    state.ending = false;
    state.notifiedEnd = false;
    state.retrying = false;
    state.connected = false;
    state.selection = null;
    state.label = "";
    state.theme = null;
    state.nearbySend = false;
    state.pendingPayload = null;
    state.shortcutCallback = "";
    clearShortcutHandoff();
    pendingReset = null;
    graceExtensionUsed = false;
    sessionExtendUsed = false;
    lastTransportKind = "";
    clearGracePrompt();
    clearSessionTheme();
    clearSafetyDots();
    clearPeerBuildBadge();
    clearOverflowBadge();
    clearTimers();
    show("pairing");
    countdown("cd-pair", 120, () => hardReset("expired", false));
    window.__P.begin(async (selection, label, meta) => {
      if (!(await requireVerifiedBuild())) return;
      state.selection = selection;
      state.label = label;
      state.nearbySend = !!(meta && meta.nearbySend);
      state.pendingPayload = normalizePendingPayload(meta && meta.payload);
      state.shortcutCallback = shortcutCallbackToken(meta && meta.shortcutCallback);
      if (meta && meta.shortcutHandoff) acceptShortcutHandoff(meta.shortcutHandoff, meta.shortcutHandoffUrl);
      $("your-pick").textContent = label;
      setLoading("creating");
      show("loading");
      clearTimers();
      await openSessionForSelection(selection);
    });
  }

  async function createSession(selection) {
    if (selection && selection.named) {
      const r = await fetch("/api/name-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: selection.name, intent: selection.intent }),
      });
      return r.json();
    }
    const r = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ m1: selection.first, path: selection.rest, bucket: selection.bucket }),
    });
    return r.json();
  }

  async function openSessionForSelection(selection) {
    let d;
    try {
      d = await createSession(selection);
      if (d && !d.ok && d.reason === "no-room" && selection && selection.named && selection.intent === "join") {
        d = await waitForNamedRoom(selection);
      }
      if (d && !d.ok && d.reason === "name-active" && selection && selection.named && selection.intent === "create") {
        const joinSelection = { ...selection, intent: "join" };
        state.selection = joinSelection;
        d = await createSession(joinSelection);
      }
    } catch {
      hardReset("network error", false);
      return;
    }
    if (!d || !d.ok || !d.token) {
      hardReset(errorText(d && d.reason), false);
      return;
    }
    state.token = d.token;
    state.endKey = "";
    state.notifiedEnd = false;
    if (d.available && selection && selection.expectPeer) {
      await waitForInvitedSeed(selection);
      return;
    }
    if (d.available) createAsSeed();
    else joinAsPeer();
  }

  async function waitForNamedRoom(selection) {
    setLoading("waiting");
    let last = { ok: false, reason: "no-room" };
    const waits = [0, 120, 180, 260, 400, 650, 1000];
    for (let i = 0; i < waits.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, waits[i]));
      try {
        const d = await createSession(selection);
        last = d || last;
        if (d && d.ok && d.token) return d;
        if (d && d.reason === "rate-limited") return d;
      } catch {}
    }
    return last;
  }

  async function waitForInvitedSeed(selection) {
    setLoading("waiting");
    for (let i = 0; i < 20; i++) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, 300));
      let d;
      try {
        d = await createSession(selection);
      } catch {
        continue;
      }
      if (d && d.ok && d.token && !d.available) {
        state.token = d.token;
        state.endKey = "";
        state.notifiedEnd = false;
        joinAsPeer();
        return;
      }
    }
    hardReset("expired", false);
  }

  async function retryAsPeer() {
    if (!state.selection) {
      hardReset("room active", false);
      return;
    }
    state.retrying = true;
    try {
      if (state.ws && state.ws.readyState <= WebSocket.OPEN) state.ws.close(1000, "retry-as-peer");
    } catch {}
    state.ws = null;

    let d;
    try {
      const nextSelection =
        state.selection && state.selection.named && state.selection.intent === "create"
          ? { ...state.selection, intent: "join" }
          : state.selection;
      d = await createSession(nextSelection);
    } catch {
      state.retrying = false;
      hardReset("network error", false);
      return;
    }
    state.retrying = false;
    if (!d || !d.ok || !d.token) {
      hardReset(errorText(d && d.reason), false);
      return;
    }
    if (state.selection && state.selection.named && state.selection.intent === "create") {
      state.selection = { ...state.selection, intent: "join" };
    }
    state.token = d.token;
    state.endKey = "";
    state.notifiedEnd = false;
    if (d.available) createAsSeed();
    else joinAsPeer();
  }

  // ---------- WebSocket signaling ----------
  function openWs(role) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const qs = new URLSearchParams({ token: state.token, role });
    const ws = new WebSocket(`${proto}://${location.host}/ws?${qs.toString()}`);
    state.ws = ws;
    state.role = role;

    ws.onmessage = (ev) => {
      try {
        handle(JSON.parse(ev.data));
      } catch {}
    };
    ws.onclose = () => {
      if (state.ws !== ws) return;
      state.ws = null;
      if (state.connected) return;
      if (!state.ending && state.mode !== "ended" && !state.retrying) hardReset("disconnected", false);
    };
    ws.onerror = () => {
      if (state.ws !== ws) return;
      if (state.connected) return;
      if (!state.ending && state.mode !== "ended" && !state.retrying) hardReset("connection error", true);
    };
    return ws;
  }

  function wsSend(msg) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
  }

  function createAsSeed() {
    state.mode = "seed";
    const ws = openWs("seed");
    ws.onopen = () => {
      applySeedWaitLabel();
      clearTimers();
      if (state.nearbySend) {
        setLoading("", true);
        show("loading");
        state.timers.push(setTimeout(() => {
          if (!state.connected) hardReset("no peer", true);
        }, 120_000));
      } else {
        show("seed-wait");
        countdown("cd-wait", 120, () => {
          if (!state.connected) hardReset("no peer", true);
        });
      }
    };
  }

  function joinAsPeer() {
    state.mode = "peer";
    setLoading("joining");
    show("loading");
    openWs("peer");
  }

  function handle(msg) {
    switch (msg.type) {
      case "error":
        if (msg.reason === "room-active" && state.role === "seed") retryAsPeer();
        else hardReset(errorText(msg.reason), false);
        break;
      case "role":
        state.endKey = msg.endKey || "";
        if (isTheme(msg.theme)) state.theme = msg.theme;
        break;
      case "peer-joined":
        setLoading("peer ready");
        break;
      case "start-webrtc":
        if (isTheme(msg.theme)) state.theme = msg.theme;
        clearTimers();
        setLoading("connecting");
        show("loading");
        startRtc(msg.initiator);
        break;
      case "offer":
      case "answer":
      case "ice-candidate":
        window.__T.signal(msg).catch(() => hardReset("signal error", true));
        break;
      case "session-expired":
        hardReset("ended", false);
        break;
      case "session-extended":
        applySessionExtended(msg.expiresAt);
        break;
      case "session-extend-denied":
        sessionExtendUsed = true;
        hideSessionExtend();
        if (msg.reason !== "extension-used") hardReset("expired", true);
        break;
      case "peer-overflow":
        showOverflowBadge(msg.reason || "peer-overflow");
        setHealth("bad", "error");
        setTransport("bad");
        break;
    }
  }

  // ---------- WebRTC ----------
  function startRtc(initiator) {
    window.__T.start(initiator, (sig) => wsSend(sig), {
      onOpen: onConnected,
      onFallback: () => {
        setLoading("relay");
        setHealth("repair", "naprawiam p2p");
        setTransport("repair", true);
      },
      onBuild: applyPeerBuild,
      onTransport: onTransport,
      onVerify: applySafetyDots,
      onClose: () => {
        if (state.connected && !state.ending) hardReset("p2p disconnected", true);
      },
      onState: (s) => {
        if (s === "connected") setHealth("ok", "connected");
        else if (s === "disconnected") {
          setHealth("repair", "naprawiam p2p");
          setTransport("repair", true);
        }
        else if (s === "failed" || s === "closed") {
          setHealth("bad", "error");
          setTransport("bad");
          if (state.connected && !state.ending) hardReset(s === "failed" ? "p2p error" : "connection lost", true);
        } else if (s === "connecting") {
          setHealth("repair", "naprawiam p2p");
          setTransport("repair", true);
        }
      },
      onText: (text) => appendMessage("in", text),
      onFileMeta: (m) => recvCard(m),
      onFileProgress: (id, r, total) => setCard(id, r / total),
      onFileComplete: (id, blob, name) => cardDownload(id, blob, name),
      onTransferCancel: (id) => cardError(id, "anulowano"),
    }).catch(() => hardReset("p2p error", true));
    state.timers.push(setTimeout(() => {
      if (!state.connected && !state.ending) hardReset("connection failed", true);
    }, 35_000));
  }

  function onConnected() {
    state.connected = true;
    state.mode = "connected";
    applySessionTheme();
    show("connected");
    clearTimers();
    sessionExtendUsed = false;
    clearOverflowBadge();
    setHealth("ok", "connected");
    setTransport("pending");
    requestAnimationFrame(autosize);
    startConnectedCountdown(SESSION_SECONDS);
    markShortcutReady();
    flushPendingPayload();
  }

  function setHealth(cls, text) {
    const b = $("health");
    b.className = "badge " + cls;
    b.textContent = text;
  }

  function setTransport(info, pending) {
    const el = $("transport");
    if (!el) return;
    const kind = typeof info === "string" ? info : info && info.transport;
    const mode = typeof info === "object" && info ? info.mode : "";
    lastTransportKind = kind || "";
    const cls = kind === "direct" ? "direct" : kind === "relay" ? "relay" : kind === "repair" ? "repair" : kind === "bad" ? "bad" : "pending";
    el.className = "badge transport " + cls;
    if (cls === "pending") el.textContent = "…";
    else if (cls === "repair") el.textContent = pending ? "p2p…" : "p2p";
    else if (cls === "bad") el.textContent = "error";
    else if (cls === "relay" && mode === "relay") el.textContent = `private relay${pending ? "…" : ""}`;
    else el.textContent = `${cls}${pending ? "…" : ""}`;
  }

  function onTransport(info) {
    if (!info || (info.transport !== "direct" && info.transport !== "relay")) return;
    setTransport(info, false);
  }

  function applyPeerBuild(info) {
    const el = $("peer-build-badge");
    if (!el) return true;
    el.hidden = false;
    if (info && info.same) {
      el.className = "badge build-peer ok";
      el.textContent = "✓";
      el.setAttribute("aria-label", "same build");
      return true;
    }
    el.className = "badge build-peer bad";
    el.textContent = "×";
    el.setAttribute("aria-label", "build mismatch");
    setHealth("bad", "error");
    setTimeout(() => hardReset("build mismatch", true, { immediate: true }), 0);
    return false;
  }

  function clearPeerBuildBadge() {
    const el = $("peer-build-badge");
    if (!el) return;
    el.hidden = true;
    el.className = "badge build-peer";
    el.textContent = "✓";
    el.setAttribute("aria-label", "same build");
  }

  function clearOverflowBadge() {
    const el = $("overflow-badge");
    if (!el) return;
    el.hidden = true;
    el.textContent = "";
  }

  function showOverflowBadge(reason) {
    const el = $("overflow-badge");
    if (!el) return;
    el.hidden = false;
    el.textContent = reason === "peer-overflow" ? "third peer blocked" : "session locked";
  }

  // ---------- editor ----------
  const editor = $("msg");
  const counter = $("counter");
  const dropzone = $("dropzone");
  const board = $("message-board");
  const stream = $("message-stream");
  const copyBoard = $("copy-board");
  const fileCount = $("file-manager-count");
  const previewTitle = $("preview-title");
  const previewMeta = $("preview-meta");
  const previewEmpty = $("preview-empty");
  const previewImage = $("preview-image");
  const previewText = $("preview-text");
  const previewEdit = $("preview-edit");
  const previewDownload = $("preview-download");
  const previewItems = new Map();
  let selectedPreviewId = "";
  let previewTextSeq = 0;
  let messageSeq = 0;
  let copyTimer = 0;

  function updateFileCount() {
    if (!fileCount) return;
    const messages = Array.from(previewItems.values()).filter((item) => item.type === "message").length;
    const files = previewItems.size - messages;
    if (!previewItems.size) fileCount.textContent = "empty";
    else if (files && messages) fileCount.textContent = `${files} files · ${messages} text`;
    else if (files) fileCount.textContent = `${files} files`;
    else fileCount.textContent = `${messages} text`;
  }

  function rememberPreviewItem(item) {
    if (!item || !item.id) return;
    previewItems.set(item.id, { ...(previewItems.get(item.id) || {}), ...item });
    updateFileCount();
    if (!selectedPreviewId) selectPreviewItem(item.id);
    else if (selectedPreviewId === item.id) renderPreview(previewItems.get(item.id));
  }

  function selectPreviewItem(id) {
    const item = previewItems.get(id);
    if (!item) return;
    selectedPreviewId = id;
    document.querySelectorAll(".preview-selected").forEach((node) => node.classList.remove("preview-selected"));
    const node = Array.from(document.querySelectorAll("[data-preview-id]")).find((el) => el.dataset.previewId === id);
    if (node) node.classList.add("preview-selected");
    renderPreview(item);
  }

  function clearPreview() {
    selectedPreviewId = "";
    previewItems.clear();
    updateFileCount();
    if (previewTitle) previewTitle.textContent = "drop text or files";
    if (previewMeta) previewMeta.textContent = "nothing is stored here after the session ends";
    if (previewEmpty) {
      previewEmpty.hidden = false;
      previewEmpty.innerHTML = "<span>select a message or file</span>";
    }
    if (previewImage) {
      previewImage.hidden = true;
      previewImage.removeAttribute("src");
      previewImage.alt = "";
    }
    if (previewText) {
      previewText.hidden = true;
      previewText.value = "";
    }
    if (previewEdit) previewEdit.hidden = true;
    if (previewDownload) previewDownload.hidden = true;
  }

  function renderPreview(item) {
    if (!item) {
      clearPreview();
      return;
    }
    const seq = ++previewTextSeq;
    const name = item.name || (item.type === "message" ? "text note" : "file");
    if (previewTitle) previewTitle.textContent = name;
    if (previewMeta) {
      const pieces = [item.direction === "out" ? "sent" : item.direction === "in" ? "received" : item.status || ""];
      if (item.kind) pieces.push(item.kind);
      if (Number.isFinite(item.size)) pieces.push(fmtBytes(item.size));
      previewMeta.textContent = pieces.filter(Boolean).join(" · ") || "ready";
    }
    if (previewEmpty) previewEmpty.hidden = true;
    if (previewImage) {
      previewImage.hidden = true;
      previewImage.removeAttribute("src");
      previewImage.alt = "";
    }
    if (previewText) {
      previewText.hidden = true;
      previewText.value = "";
    }
    if (previewDownload) {
      previewDownload.hidden = !item.blob && item.type !== "message";
      previewDownload.onclick = () => downloadPreviewItem(item);
    }
    if (previewEdit) {
      previewEdit.hidden = item.type !== "message" && item.kind !== "text" && item.kind !== "code";
      previewEdit.onclick = () => editPreviewItem(item);
    }

    if (item.type === "message") {
      showPreviewText(item.text || "");
      return;
    }
    if (!item.blob) {
      showPreviewEmpty(item.status || "transfer in progress");
      return;
    }
    if (item.kind === "image") {
      const url = item.url || URL.createObjectURL(item.blob);
      item.url = url;
      objectUrls.add(url);
      previewImage.src = url;
      previewImage.alt = name;
      previewImage.hidden = false;
      return;
    }
    if (item.kind === "text" || item.kind === "code") {
      previewText.hidden = false;
      previewText.value = "loading…";
      item.blob
        .slice(0, 96_000)
        .text()
        .then((text) => {
          if (seq !== previewTextSeq) return;
          previewText.value = text + (item.blob.size > 96_000 ? "\n\n… truncated preview" : "");
        })
        .catch(() => {
          if (seq === previewTextSeq) showPreviewEmpty("preview unavailable");
        });
      return;
    }
    showPreviewEmpty("preview unavailable · download to open");
  }

  function showPreviewText(text) {
    if (!previewText) return;
    previewText.hidden = false;
    previewText.value = String(text || "");
  }

  function showPreviewEmpty(text) {
    if (!previewEmpty) return;
    previewEmpty.hidden = false;
    previewEmpty.innerHTML = "";
    const span = document.createElement("span");
    span.textContent = text;
    previewEmpty.appendChild(span);
  }

  function editPreviewItem(item) {
    if (!item) return;
    const placeText = (text) => {
      editor.value = String(text || "");
      autosize();
      editor.focus();
      editor.setSelectionRange(editor.value.length, editor.value.length);
    };
    if (item.type === "message") {
      placeText(item.text);
      return;
    }
    if (!item.blob) return;
    item.blob
      .slice(0, 96_000)
      .text()
      .then(placeText)
      .catch(() => {});
  }

  function downloadPreviewItem(item) {
    if (!item) return;
    if (item.blob) {
      const url = item.url || URL.createObjectURL(item.blob);
      item.url = url;
      objectUrls.add(url);
      downloadBlobUrl(url, item.name || "plik");
      return;
    }
    if (item.type === "message") {
      const file = textMessageFile(item.text || "");
      const url = URL.createObjectURL(file);
      objectUrls.add(url);
      downloadBlobUrl(url, file.name);
      setTimeout(() => {
        URL.revokeObjectURL(url);
        objectUrls.delete(url);
      }, 60_000);
    }
  }

  function autosize() {
    editor.style.height = "auto";
    editor.style.height = Math.min(Math.max(editor.scrollHeight, 42), 124) + "px";
    const len = editor.value.length;
    const empty = len === 0;
    counter.textContent = empty ? "+" : String(len);
    counter.classList.toggle("is-plus", empty);
    counter.title = empty ? "attach file" : `${len} characters`;
    counter.setAttribute("aria-label", empty ? "attach file" : `${len} characters`);
    dropzone.classList.toggle("has-text", len > 0);
  }
  editor.addEventListener("input", autosize);
  editor.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendText();
    }
  });
  function sendText() {
    const v = editor.value.trim();
    if (!v || !window.__T.isOpen()) return;
    sendTextValue(v);
    editor.value = "";
    autosize();
  }
  $("send").addEventListener("click", sendText);
  counter.addEventListener("click", () => {
    if (counter.classList.contains("is-plus")) $("file-input").click();
  });

  function appendMessage(direction, text) {
    const value = String(text || "").trim();
    if (!value) return;
    const id = `msg-${Date.now()}-${++messageSeq}`;
    board.hidden = true;
    makeTextCard(id, direction, value);
  }

  function makeTextCard(id, direction, text) {
    const item = {
      id,
      type: "message",
      direction,
      kind: "text",
      name: direction === "out" ? "sent text" : "received text",
      size: text.length,
      text,
    };
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.classList.add("text-att", "done");
    node.dataset.id = id;
    node.dataset.previewId = id;
    node.querySelector(".att-name").textContent = item.name;
    node.querySelector(".att-size").textContent = fmtBytes(item.size);
    node.querySelector(".att-state").textContent = direction === "out" ? "sent" : "received";
    node.querySelector(".att-fill").style.width = "100%";
    decorateCard(node, { name: item.name + ".txt", size: item.size, mime: "text/plain", kind: "text" });
    node.addEventListener("click", () => selectPreviewItem(id));
    const action = node.querySelector(".att-action");
    action.textContent = "";
    action.style.display = "none";
    attWrap.prepend(node);
    cards[id] = node;
    rememberPreviewItem(item);
  }

  async function copyMessages() {
    const text = Array.from(stream.querySelectorAll(".msg-bubble"))
      .map((node) => node.textContent.trim())
      .filter(Boolean)
      .join("\n\n");
    if (!text) return;
    try {
      await copyToClipboard(text);
      copyBoard.textContent = "✓";
      copyBoard.classList.add("copied");
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copyBoard.textContent = "⧉";
        copyBoard.classList.remove("copied");
      }, 1100);
    } catch {
      copyBoard.textContent = "!";
      copyBoard.classList.remove("copied");
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copyBoard.textContent = "⧉";
      }, 1100);
    }
  }

  async function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (!ok) throw new Error("copy failed");
  }

  function textMessageFile(text) {
    const detected = detectTextLanguage(text);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
    return new File([text], `wklej-message-${stamp}.${detected.ext}`, { type: detected.mime });
  }

  function detectTextLanguage(text) {
    const s = text.trim();
    if (looksJson(s)) return { ext: "json", mime: "application/json" };
    if (/^#!/.test(s) && /\b(?:sh|bash|zsh)\b/.test(s.split("\n")[0])) return { ext: "sh", mime: "text/x-shellscript" };
    if (/<!doctype html|<html[\s>]|<\/(?:div|script|style|body|html)>/i.test(s)) return { ext: "html", mime: "text/html" };
    if (/^\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/im.test(s)) return { ext: "sql", mime: "text/plain" };
    if (/^\s*(?:def|class)\s+\w+|^\s*(?:from\s+\S+\s+import|import\s+\S+)|print\(/m.test(s)) return { ext: "py", mime: "text/x-python" };
    if (/\binterface\s+\w+|\btype\s+\w+\s*=|:\s*(?:string|number|boolean)\b/.test(s)) return { ext: "ts", mime: "text/typescript" };
    if (/\b(?:const|let|var|function)\b|=>|console\.log|^\s*(?:import|export)\s+/m.test(s)) return { ext: "js", mime: "text/javascript" };
    if (/^\s*(?:package\s+main|func\s+\w+|import\s+\()/m.test(s)) return { ext: "go", mime: "text/plain" };
    if (/^\s*(?:fn\s+\w+|use\s+[\w:]+|let\s+mut\s+)/m.test(s)) return { ext: "rs", mime: "text/plain" };
    if (/^\s*(?:#[A-Za-z0-9_ -]+|```|[-*]\s+|\d+\.\s+)/m.test(s)) return { ext: "md", mime: "text/markdown" };
    if (/^\s*[\w.-]+:\s+.+$/m.test(s) && !/[{};]/.test(s)) return { ext: "yml", mime: "text/yaml" };
    if (/^[^{}]+\{[^{}]+:[^{}]+;\s*}/m.test(s)) return { ext: "css", mime: "text/css" };
    if (/^\s*(?:curl|git|npm|pnpm|yarn|cd|mkdir|rm|cp|mv|echo|export)\b/m.test(s)) return { ext: "sh", mime: "text/x-shellscript" };
    return { ext: "txt", mime: "text/plain" };
  }

  function looksJson(text) {
    if (!/^[\[{]/.test(text)) return false;
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }

  copyBoard.addEventListener("click", copyMessages);

  function sendTextValue(text) {
    const value = String(text || "").trim();
    if (!value || !window.__T.isOpen()) return;
    if (value.length > LONG_TEXT_LIMIT) {
      enqueue([textMessageFile(value)]);
      return;
    }
    window.__T.sendText(value);
    appendMessage("out", value);
  }

  function normalizePendingPayload(payload) {
    if (!payload || typeof payload !== "object") return null;
    if (payload.kind === "file" && payload.file instanceof File && payload.file.size <= MAX_FILE) {
      return { kind: "file", file: payload.file };
    }
    if (payload.kind === "text" && typeof payload.text === "string" && payload.text.trim()) {
      return { kind: "text", text: payload.text };
    }
    return null;
  }

  function acceptShortcutHandoff(token, handoffUrl) {
    const value = String(token || "").trim();
    if (!/^[A-Za-z0-9_-]{24,96}$/.test(value)) return;
    shortcutHandoffToken = value;
    window.addEventListener("message", onShortcutHandoffMessage);
    const url = shortcutLocalHandoffUrl(handoffUrl, value);
    if (url) fetchShortcutHandoff(url, value);
  }

  function clearShortcutHandoff() {
    shortcutHandoffToken = "";
    window.removeEventListener("message", onShortcutHandoffMessage);
  }

  function onShortcutHandoffMessage(ev) {
    const data = ev && ev.data;
    if (!shortcutHandoffToken || !data || data.type !== "wklej-shortcut-file" || data.token !== shortcutHandoffToken) return;
    processShortcutHandoff(data);
  }

  async function fetchShortcutHandoff(url, token) {
    try {
      const res = await fetch(url, { cache: "no-store", mode: "cors" });
      if (!res.ok || token !== shortcutHandoffToken) return;
      processShortcutHandoff(await res.json());
    } catch {}
  }

  function shortcutLocalHandoffUrl(value, token) {
    try {
      const url = new URL(String(value || ""));
      const port = Number(url.port);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !Number.isInteger(port) || port < 1024 || port > 65535) return "";
      if (!url.pathname.includes(token)) return "";
      return url.href;
    } catch {
      return "";
    }
  }

  function processShortcutHandoff(data) {
    if (!shortcutHandoffToken || !data || data.type !== "wklej-shortcut-file" || data.token !== shortcutHandoffToken) return;
    const payload = shortcutHandoffPayload(data);
    clearShortcutHandoff();
    if (!payload) return;
    state.pendingPayload = payload;
    if (state.connected && !state.ending) flushPendingPayload();
  }

  function shortcutHandoffPayload(data) {
    if (typeof data.text === "string" && data.text.trim()) {
      return normalizePendingPayload({ kind: "text", text: data.text });
    }
    if (typeof data.file === "string") {
      const bytes = shortcutBase64ToBytes(data.file);
      if (!bytes || bytes.byteLength > MAX_FILE) return null;
      const name = shortcutFileName(data.filename, data.mime);
      const mime = shortcutMime(data.mime);
      return normalizePendingPayload({ kind: "file", file: new File([bytes], name, { type: mime }) });
    }
    return null;
  }

  function shortcutBase64ToBytes(value) {
    try {
      const normalized = String(value || "").replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
      const raw = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      return bytes;
    } catch {
      return null;
    }
  }

  function shortcutMime(value) {
    const mime = String(value || "").trim().toLowerCase();
    return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(mime) ? mime : "application/octet-stream";
  }

  function shortcutFileName(value, mime) {
    const clean = String(value || "")
      .normalize("NFKC")
      .replace(/[\\/\0\r\n]+/g, " ")
      .trim()
      .slice(0, 96);
    if (clean) return clean;
    const ext = mime === "text/plain" ? "txt" : mime === "image/jpeg" ? "jpg" : mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "bin";
    return `wklej-shortcut.${ext}`;
  }

  function onShortcutPayloadEvent(ev) {
    const payload = normalizePendingPayload(ev && ev.detail && ev.detail.payload);
    if (!payload) return;
    if (!shortcutTargetMatches(ev && ev.detail)) return;
    const id = ev && ev.detail && typeof ev.detail.id === "string" ? ev.detail.id : "";
    if (id) rememberShortcutPayload(id);
    acceptShortcutPayload(payload, false);
  }

  function acceptShortcutPayload(payload, requireConnected) {
    if (requireConnected && (!state.connected || state.ending)) return false;
    state.pendingPayload = payload;
    if (state.connected && !state.ending) flushPendingPayload();
    return true;
  }

  function installShortcutPayloadBridge() {
    shortcutServiceWorkerReady = ensureShortcutServiceWorker();
    if ("BroadcastChannel" in window) {
      try {
        shortcutPayloadChannel = new BroadcastChannel(SHORTCUT_PAYLOAD_CHANNEL);
        shortcutPayloadChannel.onmessage = (ev) => handleShortcutPayloadEnvelope(ev.data, false);
      } catch {
        shortcutPayloadChannel = null;
      }
    }
    window.addEventListener("storage", (ev) => {
      if (ev.key === SHORTCUT_PAYLOAD_STORAGE && ev.newValue) handleShortcutPayloadEnvelope(ev.newValue, true);
    });
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", (ev) => {
        const accepted = handleShortcutPayloadEnvelope(ev.data, false);
        if (accepted && ev.ports && ev.ports[0]) {
          try {
            ev.ports[0].postMessage({ ok: true, id: ev.data && ev.data.id });
          } catch {}
        }
      });
    }
    shortcutPayloadPollTimer = window.setInterval(readShortcutPayloadStorage, 900);
  }

  async function ensureShortcutServiceWorker() {
    if (!("serviceWorker" in navigator)) return false;
    try {
      const registration = await navigator.serviceWorker.register("/shortcut-sw.js", { scope: "/" });
      try {
        await registration.update();
      } catch {}
      const nextWorker = registration.installing || registration.waiting;
      if (nextWorker && nextWorker.state !== "activated") {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 4000);
          const done = () => {
            clearTimeout(timer);
            resolve();
          };
          nextWorker.addEventListener("statechange", () => {
            if (nextWorker.state === "activated" || nextWorker.state === "redundant") done();
          });
          navigator.serviceWorker.addEventListener("controllerchange", done, { once: true });
        });
      }
      await navigator.serviceWorker.ready;
      if (navigator.serviceWorker.controller) return true;
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(!!navigator.serviceWorker.controller), 2000);
        navigator.serviceWorker.addEventListener(
          "controllerchange",
          () => {
            clearTimeout(timer);
            resolve(true);
          },
          { once: true },
        );
      });
    } catch {
      return false;
    }
  }

  function readShortcutPayloadStorage() {
    if (!state.connected || state.ending) return;
    let raw = "";
    try {
      raw = localStorage.getItem(SHORTCUT_PAYLOAD_STORAGE) || "";
    } catch {
      return;
    }
    if (raw) handleShortcutPayloadEnvelope(raw, true);
  }

  function handleShortcutPayloadEnvelope(raw, fromStorage) {
    if (!state.connected || state.ending) return false;
    let data = raw;
    if (typeof raw === "string") {
      try {
        data = JSON.parse(raw);
      } catch {
        return false;
      }
    }
    if (!data || data.type !== "wklej-shortcut-payload") return false;
    if (!shortcutTargetMatches(data)) return false;
    const id = typeof data.id === "string" ? data.id : "";
    if (!id || seenShortcutPayloads.has(id)) return false;
    if (!Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now()) {
      if (fromStorage) clearStoredShortcutPayload(id);
      return false;
    }
    const payload = shortcutPayloadFromEnvelope(data.payload);
    if (!payload) return false;
    rememberShortcutPayload(id);
    if (fromStorage) clearStoredShortcutPayload(id);
    const accepted = acceptShortcutPayload(payload, true);
    return accepted;
  }

  function shortcutPayloadFromEnvelope(payload) {
    if (!payload || typeof payload !== "object") return null;
    if (payload.kind === "text" && typeof payload.text === "string") {
      return normalizePendingPayload({ kind: "text", text: payload.text });
    }
    if (payload.kind !== "file") return null;
    if (payload.file instanceof File) {
      return normalizePendingPayload({ kind: "file", file: payload.file });
    }
    const name = shortcutFileName(payload.name || payload.filename, payload.mime);
    const mime = shortcutMime(payload.mime);
    if (typeof payload.file === "string") {
      const bytes = shortcutBase64ToBytes(payload.file);
      if (!bytes || bytes.byteLength > MAX_FILE) return null;
      return normalizePendingPayload({ kind: "file", file: new File([bytes], name, { type: mime }) });
    }
    if (payload.buffer instanceof ArrayBuffer) {
      if (payload.buffer.byteLength > MAX_FILE) return null;
      return normalizePendingPayload({ kind: "file", file: new File([payload.buffer], name, { type: mime }) });
    }
    return null;
  }

  function shortcutTargetMatches(data) {
    if (!data || typeof data !== "object") return true;
    const targetRole = String(data.targetRole || "").trim().toLowerCase();
    if ((targetRole === "seed" || targetRole === "peer") && state.role !== targetRole) return false;
    const room = String(data.room || "")
      .normalize("NFKC")
      .trim()
      .toLowerCase();
    if (!room) return true;
    const current = state.selection && state.selection.named ? String(state.selection.name || "").trim().toLowerCase() : "";
    return current === room;
  }

  function rememberShortcutPayload(id) {
    seenShortcutPayloads.add(id);
    if (seenShortcutPayloads.size <= 64) return;
    const first = seenShortcutPayloads.values().next().value;
    if (first) seenShortcutPayloads.delete(first);
  }

  function clearStoredShortcutPayload(id) {
    try {
      const raw = localStorage.getItem(SHORTCUT_PAYLOAD_STORAGE);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!id || data.id === id) localStorage.removeItem(SHORTCUT_PAYLOAD_STORAGE);
    } catch {}
  }

  function shortcutCallbackToken(value) {
    const clean = String(value || "")
      .normalize("NFKC")
      .trim()
      .slice(0, 96);
    return /^[A-Za-z0-9._ -]{4,96}$/.test(clean) && new Set(clean.replace(/[^A-Za-z0-9]/g, "").toLowerCase()).size >= 2 ? clean : "";
  }

  async function markShortcutReady() {
    const callback = shortcutCallbackToken(state.shortcutCallback);
    if (!callback) return;
    if (!(await shortcutServiceWorkerReady)) return;
    state.shortcutCallback = "";
    fetch("/api/shortcut-ready", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback }),
      keepalive: true,
    }).catch(() => {});
  }

  function flushPendingPayload() {
    const payload = state.pendingPayload;
    state.pendingPayload = null;
    if (!payload || !window.__T.isOpen()) return;
    if (payload.kind === "file") enqueue([payload.file]);
    else if (payload.kind === "text") sendTextValue(payload.text);
  }

  // ---------- attachments ----------
  const attWrap = $("attachments");
  const attHead = $("attachments-head");
  const zipAll = $("zip-all");
  const tpl = $("att-card");
  const cards = {};
  const objectUrls = new Set();
  const completedAttachments = new Map();
  const queue = [];
  let sending = false;
  let attachmentNavTimer = 0;

  function makeCard(id, name, size, stateText, cancelable, meta) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = id;
    node.dataset.previewId = id;
    node.querySelector(".att-name").textContent = name;
    node.querySelector(".att-size").textContent = fmtBytes(size);
    node.querySelector(".att-state").textContent = stateText;
    decorateCard(node, meta || { name, size });
    node.addEventListener("click", () => selectPreviewItem(id));
    const action = node.querySelector(".att-action");
    if (cancelable) {
      action.textContent = "×";
      action.title = "anuluj";
      action.onclick = (event) => {
        event.stopPropagation();
        window.__T.cancelTransfer(id);
      };
    } else {
      action.textContent = "";
      action.style.display = "none";
    }
    attWrap.prepend(node);
    cards[id] = node;
    rememberPreviewItem({
      id,
      type: "file",
      status: stateText,
      direction: cancelable ? "out" : "in",
      name,
      size,
      mime: meta && meta.mime,
      kind: fileKind(name, String((meta && meta.mime) || "")),
    });
    return node;
  }

  function decorateCard(node, meta) {
    const icon = node.querySelector(".att-icon");
    const mime = String((meta && meta.mime) || "");
    const name = String((meta && meta.name) || node.querySelector(".att-name").textContent || "");
    const kind = String((meta && meta.kind) || fileKind(name, mime));
    icon.className = "att-icon";
    icon.style.backgroundImage = "";
    icon.textContent = iconForKind(kind);
    const preview = typeof (meta && meta.preview) === "string" ? meta.preview : "";
    if (isSafePreview(preview)) {
      icon.classList.add("att-thumb");
      icon.style.backgroundImage = `url(${preview})`;
      icon.textContent = "";
    }
  }

  function setCardImagePreview(node, url) {
    const icon = node.querySelector(".att-icon");
    icon.className = "att-icon att-thumb";
    icon.style.backgroundImage = `url(${url})`;
    icon.textContent = "";
  }

  function isSafePreview(value) {
    return /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value) && value.length <= 90_000;
  }

  function fileKind(name, mime) {
    const lower = name.toLowerCase();
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    if (mime === "application/pdf" || lower.endsWith(".pdf")) return "pdf";
    if (/\.(js|jsx|ts|tsx|py|go|rs|java|c|cpp|h|hpp|cs|php|rb|swift|kt|sh|sql|json|html|css|xml|yml|yaml|toml)$/i.test(lower)) return "code";
    if (mime.startsWith("text/") || lower.endsWith(".txt") || lower.endsWith(".md")) return "text";
    if (/\.(zip|rar|7z|tar|gz)$/i.test(lower)) return "archive";
    if (/\.(doc|docx|odt|pages)$/i.test(lower)) return "doc";
    if (/\.(xls|xlsx|csv|numbers)$/i.test(lower)) return "sheet";
    return "file";
  }

  function iconForKind(kind) {
    return ({
      image: "🖼",
      video: "🎬",
      audio: "♪",
      pdf: "PDF",
      archive: "ZIP",
      doc: "DOC",
      sheet: "XLS",
      code: "</>",
      text: "TXT",
      file: "📄",
    })[kind] || "📄";
  }

  function setCard(id, frac) {
    const n = cards[id];
    if (!n) return;
    n.querySelector(".att-fill").style.width = Math.round(frac * 100) + "%";
    rememberPreviewItem({ id, status: `${Math.round(frac * 100)}%` });
  }

  function cardDone(id, text) {
    const n = cards[id];
    if (!n) return;
    n.classList.add("done");
    n.querySelector(".att-fill").style.width = "100%";
    n.querySelector(".att-state").textContent = text;
    n.querySelector(".att-action").style.display = "none";
    rememberPreviewItem({ id, status: text });
  }

  function cardError(id, text) {
    const n = cards[id];
    if (!n) return;
    n.classList.add("error");
    n.querySelector(".att-state").textContent = text || "błąd";
    n.querySelector(".att-action").style.display = "none";
    rememberPreviewItem({ id, status: text || "błąd" });
  }

  function recvCard(m) {
    makeCard(m.id, m.name, m.size, "odbieranie…", false, m);
  }

  function cardDownload(id, blob, name) {
    const n = cards[id];
    if (!n) return;
    n.classList.add("done");
    n.querySelector(".att-fill").style.width = "100%";
    n.querySelector(".att-state").textContent = "odebrano";
    const url = URL.createObjectURL(blob);
    objectUrls.add(url);
    rememberAttachment(id, blob, name || "plik");
    if ((blob.type || "").startsWith("image/")) setCardImagePreview(n, url);
    const a = n.querySelector(".att-action");
    a.textContent = "";
    a.style.display = "none";
    rememberPreviewItem({
      id,
      type: "file",
      status: "odebrano",
      direction: "in",
      name: name || "plik",
      size: blob.size,
      mime: blob.type,
      kind: fileKind(name || "plik", blob.type || ""),
      blob,
      url,
    });
  }

  function rememberAttachment(id, blob, name) {
    completedAttachments.set(id, { blob, name: safeFileName(name, `plik-${completedAttachments.size + 1}`) });
    rememberPreviewItem({
      id,
      type: "file",
      status: "ready",
      name: safeFileName(name, `plik-${completedAttachments.size + 1}`),
      size: blob.size,
      mime: blob.type,
      kind: fileKind(name || "plik", blob.type || ""),
      blob,
    });
    updateZipButton();
  }

  function updateZipButton() {
    const count = completedAttachments.size;
    if (!attHead || !zipAll) return;
    attHead.hidden = count < 2;
    zipAll.textContent = `zip ${count} ↓`;
    zipAll.title = `download ${count} attachments as zip`;
    zipAll.setAttribute("aria-label", `download ${count} attachments as zip`);
  }

  function safeFileName(name, fallback) {
    const clean = String(name || "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);
    return clean || fallback;
  }

  function downloadBlobUrl(url, name) {
    protectAttachmentNavigation();
    const link = document.createElement("a");
    link.href = url;
    link.download = safeFileName(name, "plik");
    link.target = "_blank";
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function protectAttachmentNavigation() {
    state.attachmentNavSafe = true;
    clearTimeout(attachmentNavTimer);
    attachmentNavTimer = setTimeout(() => {
      state.attachmentNavSafe = false;
      attachmentNavTimer = 0;
    }, 30_000);
  }

  function clearAttachmentNavigationProtection() {
    clearTimeout(attachmentNavTimer);
    attachmentNavTimer = 0;
    state.attachmentNavSafe = false;
  }

  async function downloadAllAsZip() {
    if (completedAttachments.size < 2 || !zipAll) return;
    const previous = zipAll.textContent;
    zipAll.disabled = true;
    zipAll.textContent = "zip…";
    try {
      const zip = await buildZip(Array.from(completedAttachments.values()));
      const url = URL.createObjectURL(zip);
      objectUrls.add(url);
      downloadBlobUrl(url, zipName());
      setTimeout(() => {
        URL.revokeObjectURL(url);
        objectUrls.delete(url);
      }, 60_000);
    } catch {
      zipAll.textContent = "zip !";
      setTimeout(updateZipButton, 1000);
      return;
    } finally {
      zipAll.disabled = false;
    }
    zipAll.textContent = previous;
    updateZipButton();
  }

  async function buildZip(items) {
    const files = [];
    const used = new Set();
    for (const item of items) {
      const name = uniqueZipName(item.name, used);
      const bytes = new Uint8Array(await item.blob.arrayBuffer());
      files.push({ name, nameBytes: new TextEncoder().encode(name), bytes, crc: crc32(bytes) });
    }

    const local = [];
    const central = [];
    let offset = 0;
    let centralSize = 0;
    for (const file of files) {
      const localHeader = zipLocalHeader(file);
      local.push(localHeader, file.nameBytes, file.bytes);
      const centralHeader = zipCentralHeader(file, offset);
      central.push(centralHeader, file.nameBytes);
      offset += localHeader.byteLength + file.nameBytes.byteLength + file.bytes.byteLength;
      centralSize += centralHeader.byteLength + file.nameBytes.byteLength;
    }
    const end = zipEndRecord(files.length, centralSize, offset);
    return new Blob([...local, ...central, end], { type: "application/zip" });
  }

  function uniqueZipName(name, used) {
    const clean = safeFileName(name, `plik-${used.size + 1}`);
    let candidate = clean;
    const dot = clean.lastIndexOf(".");
    const base = dot > 0 ? clean.slice(0, dot) : clean;
    const ext = dot > 0 ? clean.slice(dot) : "";
    let index = 2;
    while (used.has(candidate.toLowerCase())) {
      candidate = `${base}-${index}${ext}`;
      index += 1;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  }

  function zipName() {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
    return `wklej-attachments-${stamp}.zip`;
  }

  function zipLocalHeader(file) {
    const out = new Uint8Array(30);
    const view = new DataView(out.buffer);
    writeZipHeaderBase(view, 0x04034b50, file);
    view.setUint16(26, file.nameBytes.byteLength, true);
    view.setUint16(28, 0, true);
    return out;
  }

  function zipCentralHeader(file, offset) {
    const out = new Uint8Array(46);
    const view = new DataView(out.buffer);
    writeZipHeaderBase(view, 0x02014b50, file);
    view.setUint16(4, 20, true);
    view.setUint16(28, file.nameBytes.byteLength, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, offset, true);
    return out;
  }

  function writeZipHeaderBase(view, signature, file) {
    const dos = dosDateTime(new Date());
    view.setUint32(0, signature, true);
    view.setUint16(signature === 0x04034b50 ? 4 : 6, 20, true);
    view.setUint16(signature === 0x04034b50 ? 6 : 8, 0x0800, true);
    view.setUint16(signature === 0x04034b50 ? 8 : 10, 0, true);
    view.setUint16(signature === 0x04034b50 ? 10 : 12, dos.time, true);
    view.setUint16(signature === 0x04034b50 ? 12 : 14, dos.date, true);
    view.setUint32(signature === 0x04034b50 ? 14 : 16, file.crc, true);
    view.setUint32(signature === 0x04034b50 ? 18 : 20, file.bytes.byteLength, true);
    view.setUint32(signature === 0x04034b50 ? 22 : 24, file.bytes.byteLength, true);
  }

  function zipEndRecord(count, centralSize, centralOffset) {
    const out = new Uint8Array(22);
    const view = new DataView(out.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(4, 0, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, count, true);
    view.setUint16(10, count, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, centralOffset, true);
    view.setUint16(20, 0, true);
    return out;
  }

  function dosDateTime(date) {
    const year = Math.max(1980, date.getFullYear());
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
  }

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function enqueue(files) {
    for (const f of files) {
      if (f.size > MAX_FILE) {
        continue;
      }
      queue.push(f);
    }
    pump();
  }

  async function pump() {
    if (sending || !queue.length || !window.__T.isOpen()) return;
    sending = true;
    const file = queue.shift();
    await new Promise((resolve) => {
      window.__T.sendFile(file, {
        onStart: (id, meta) => makeCard(id, file.name, file.size, "wysyłanie…", true, meta),
        onProgress: (id, sent, total) => setCard(id, sent / total),
        onDone: (id) => {
          cardDone(id, "wysłano");
          rememberAttachment(id, file, file.name);
          resolve();
        },
        onError: (id) => {
          cardError(id);
          resolve();
        },
        onCancel: (id) => {
          cardError(id, "anulowano");
          resolve();
        },
      });
    });
    sending = false;
    pump();
  }

  $("attach").addEventListener("click", () => $("file-input").click());
  if (zipAll) zipAll.addEventListener("click", downloadAllAsZip);
  $("file-input").addEventListener("change", (e) => {
    if (e.target.files && e.target.files.length) enqueue(e.target.files);
    e.target.value = "";
  });

  const overlay = $("drag-overlay");
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    if (!state.connected) return;
    e.preventDefault();
    dragDepth++;
    overlay.hidden = false;
  });
  window.addEventListener("dragover", (e) => {
    if (state.connected) e.preventDefault();
  });
  window.addEventListener("dragleave", () => {
    if (!state.connected) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) overlay.hidden = true;
  });
  window.addEventListener("drop", (e) => {
    if (!state.connected) return;
    e.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    if (e.dataTransfer && e.dataTransfer.files.length) enqueue(e.dataTransfer.files);
  });

  // ---------- instructions ----------
  function showInfoModal() {
    const modal = $("info-modal");
    if (!modal) return;
    setDotPattern($("info-dot-pattern"), randomDotPattern());
    modal.hidden = false;
    modal.classList.add("show");
    const close = $("info-close");
    if (close) requestAnimationFrame(() => close.focus({ preventScroll: true }));
  }

  function hideInfoModal() {
    const modal = $("info-modal");
    if (!modal) return;
    modal.classList.remove("show");
    modal.hidden = true;
  }

  // ---------- teardown ----------
  function canDelayReset() {
    return state.mode === "connected" && state.connected && !state.ending;
  }

  function clearGraceTimers() {
    clearInterval(graceCountdownInterval);
    clearTimeout(graceCountdownTimeout);
    clearInterval(graceExtendInterval);
    clearTimeout(graceExtendTimeout);
    graceCountdownInterval = 0;
    graceCountdownTimeout = 0;
    graceExtendInterval = 0;
    graceExtendTimeout = 0;
  }

  function clearGracePrompt() {
    clearGraceTimers();
    const modal = $("grace-modal");
    if (modal) {
      modal.classList.remove("show");
      modal.hidden = true;
    }
  }

  function graceReasonText(reason) {
    return ({
      expired: "time ended - download attachments or copy text",
      ended: "peer ended - download attachments or copy text",
      "p2p disconnected": "peer disconnected - download attachments or copy text",
      "connection lost": "connection lost - download attachments or copy text",
      "p2p error": "connection error - download attachments or copy text",
    })[reason] || "download attachments or copy text";
  }

  function beginGraceShutdown(reason, notify) {
    if (pendingReset) {
      pendingReset.notify = pendingReset.notify || !!notify;
      return;
    }
    pendingReset = { reason: reason || "ended", notify: !!notify };
    clearTimers();
    clearGracePrompt();
    setHealth("warn", "ending");
    showGracePrompt();
  }

  function showGracePrompt() {
    if (!pendingReset) return;
    clearGraceTimers();
    const modal = $("grace-modal");
    const count = $("grace-count");
    const text = $("grace-reason");
    if (!modal || !count) {
      finalizePendingReset();
      return;
    }
    let left = GRACE_PROMPT_SECONDS;
    count.textContent = String(left);
    if (text) text.textContent = graceReasonText(pendingReset.reason);
    const extend = $("grace-extend");
    const end = $("grace-end");
    if (extend) {
      extend.hidden = graceExtensionUsed;
      extend.disabled = graceExtensionUsed;
    }
    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add("show"));
    const focusTarget = graceExtensionUsed ? end : extend;
    if (focusTarget) requestAnimationFrame(() => focusTarget.focus({ preventScroll: true }));
    graceCountdownInterval = setInterval(() => {
      if (left > 1) {
        left -= 1;
        count.textContent = String(left);
      }
    }, 1000);
    graceCountdownTimeout = setTimeout(finalizePendingReset, GRACE_PROMPT_SECONDS * 1000);
  }

  function extendGraceShutdown() {
    if (!pendingReset || graceExtensionUsed) return;
    graceExtensionUsed = true;
    clearGracePrompt();
    setHealth("warn", "extended");
    let left = GRACE_EXTEND_SECONDS;
    const cd = $("cd-conn");
    if (cd) cd.textContent = String(left);
    graceExtendInterval = setInterval(() => {
      left -= 1;
      if (cd) cd.textContent = String(Math.max(0, left));
    }, 1000);
    graceExtendTimeout = setTimeout(() => {
      clearGraceTimers();
      finalizePendingReset();
    }, GRACE_EXTEND_SECONDS * 1000);
  }

  function finalizePendingReset() {
    const reset = pendingReset || { reason: "ended", notify: false };
    pendingReset = null;
    finalizeHardReset(reset.reason, reset.notify);
  }

  function notifyEnd() {
    if (!state.token || state.notifiedEnd) return;
    state.notifiedEnd = true;
    try {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: "terminate" }));
    } catch {}
    if (!state.endKey) return;
    const body = JSON.stringify({ token: state.token, endKey: state.endKey });
    try {
      if (navigator.sendBeacon) navigator.sendBeacon("/api/end", new Blob([body], { type: "application/json" }));
    } catch {}
    try {
      fetch("/api/end", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
    } catch {}
  }

  function purgeSensitiveDom() {
    hideInfoModal();
    clearGracePrompt();
    editor.value = "";
    dropzone.classList.remove("has-text");
    autosize();
    stream.textContent = "";
    copyBoard.textContent = "⧉";
    copyBoard.classList.remove("copied");
    clearTimeout(copyTimer);
    board.hidden = true;
    attWrap.textContent = "";
    for (const id in cards) delete cards[id];
    completedAttachments.clear();
    updateZipButton();
    clearPreview();
    $("your-pick").textContent = "";
    $("seed-label").textContent = "";
    $("seed-label").classList.remove("wait-name", "wait-emoji");
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.clear();
    queue.length = 0;
    sending = false;
    dragDepth = 0;
    overlay.hidden = true;
    clearAttachmentNavigationProtection();
    clearSessionTheme();
    clearSafetyDots();
    clearPeerBuildBadge();
    clearOverflowBadge();
    lastTransportKind = "";
    window.__P.reset();
  }

  function forgetSessionIdentity() {
    state.token = "";
    state.endKey = "";
    state.label = "";
    state.selection = null;
    state.role = null;
    state.ws = null;
    state.theme = null;
    state.pendingPayload = null;
    state.attachmentNavSafe = false;
    pendingReset = null;
    sessionExtendUsed = false;
  }

  function closeTransports() {
    try {
      window.__T.close();
    } catch {}
    try {
      if (state.ws && state.ws.readyState <= WebSocket.OPEN) state.ws.close(1000, "client-reset");
    } catch {}
    state.ws = null;
  }

  function hardReset(reason, notify, options) {
    if (!(options && options.immediate) && canDelayReset()) {
      beginGraceShutdown(reason, notify);
      return;
    }
    finalizeHardReset(reason, notify);
  }

  function finalizeHardReset(reason, notify) {
    if (state.ending) return;
    state.ending = true;
    state.mode = "ended";
    state.connected = false;
    pendingReset = null;
    clearGracePrompt();
    clearTimers();
    if (notify) notifyEnd();
    closeTransports();
    purgeSensitiveDom();
    forgetSessionIdentity();
    $("end-text").textContent = reason || "ended";
    show("ended");
    setTimeout(() => location.replace("/"), 80);
  }

  function errorText(reason) {
    return ({
      "bad-path": "expired",
      "expired-path": "expired",
      "rate-limited": "slow down",
      "bad-name": "bad name",
      "name-active": "name active",
      "no-room": "no room",
      "server-misconfig": "config error",
      "room-active": "room active",
      "no-active-room": "no room",
      "peer-taken": "full",
      "peer-overflow": "too many peers",
    })[reason] || "connection error";
  }

  window.addEventListener("pagehide", () => {
    if (state.attachmentNavSafe) return;
    if (state.token && state.role && state.mode !== "ended") {
      state.ending = true;
      pendingReset = null;
      clearGracePrompt();
      notifyEnd();
      clearTimers();
      purgeSensitiveDom();
      closeTransports();
      forgetSessionIdentity();
    }
  });

  window.addEventListener("pageshow", (e) => {
    if (e.persisted && state.attachmentNavSafe) {
      clearAttachmentNavigationProtection();
      return;
    }
    if (e.persisted) location.replace("/");
  });

  document.querySelectorAll("[data-action]").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.dataset.action === "restart") {
        if (state.token && state.role && state.mode !== "ended") hardReset("closed", true, { immediate: true });
        else location.replace("/");
      }
    }),
  );

  $("page-refresh").addEventListener("click", () => {
    if (state.token && state.role && state.mode !== "ended") hardReset("refreshed", true, { immediate: true });
    else location.replace("/");
  });

  const infoBtn = $("page-info");
  const infoModal = $("info-modal");
  const infoClose = $("info-close");
  const sessionExtend = $("session-extend");
  if (infoBtn) infoBtn.addEventListener("click", showInfoModal);
  if (infoClose) infoClose.addEventListener("click", hideInfoModal);
  if (sessionExtend) sessionExtend.addEventListener("click", requestSessionExtend);
  if (infoModal) {
    infoModal.addEventListener("click", (ev) => {
      if (ev.target === infoModal) hideInfoModal();
    });
  }
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") hideInfoModal();
  });

  $("grace-extend").addEventListener("click", extendGraceShutdown);
  $("grace-end").addEventListener("click", finalizePendingReset);

  window.addEventListener("wklej-shortcut-payload", onShortcutPayloadEvent);
  installShortcutPayloadBridge();
  autosize();
  buildReady = verifyBuildSurface()
    .then(() => {
      buildVerified = true;
      return true;
    })
    .catch((err) => {
      blockUnverifiedBuild();
      throw err;
    });
  beginPairing();
})();
