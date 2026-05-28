// WebRTC P2P transport + WebCrypto E2EE chunked file/text transfer protocol.
// Signaling (offer/answer/ice) goes over the WS; ALL application payload (text
// and files) is encrypted in the browser and travels ONLY over the RTCDataChannel.
// The backend never sees plaintext or app-layer session keys.

(function () {
  const STUN_FALLBACK = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
  const CHUNK_SIZE = 16 * 1024; // 16 KiB — safe across browsers incl. iOS Safari
  const BUFFER_HIGH = 8 * 1024 * 1024; // pause sending above 8 MiB buffered
  const BUFFER_LOW = 256 * 1024; // resume when drained below 256 KiB
  const AUTO_FALLBACK_MS = 2600;
  const E2EE_MAGIC = 0xe2;
  const E2EE_JSON = 1;
  const E2EE_BINARY = 2;
  const MAX_PENDING_E2EE = 64;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function requestedIceMode() {
    const params = new URLSearchParams(location.search);
    const mode = params.get("ice");
    return mode === "direct" || mode === "relay" ? mode : "auto";
  }

  function localIceMode() {
    const explicit = requestedIceMode();
    if (explicit !== "auto") return explicit;
    return "auto";
  }

  function signalIceMode(value) {
    return value === "direct" || value === "relay" ? value : "";
  }

  let relayConfigPromise = null;

  // Auto starts with direct STUN/P2P. Relay credentials are warmed in the
  // background, so fallback does not pay a TURN minting round-trip later.
  async function fetchIceConfig(mode) {
    try {
      const r = await fetch(`/api/ice?mode=${mode}`);
      if (!r.ok) {
        if (mode === "relay") throw new Error("relay unavailable");
        return STUN_FALLBACK;
      }
      const d = await r.json();
      if (d && Array.isArray(d.iceServers) && d.iceServers.length) {
        const hasTurn = d.iceServers.some((s) => {
          const u = s.urls;
          const arr = Array.isArray(u) ? u : [u];
          return arr.some((x) => typeof x === "string" && x.indexOf("turn") === 0);
        });
        return {
          iceServers: d.iceServers,
          iceTransportPolicy: mode === "relay" && hasTurn ? "relay" : "all",
          iceCandidatePoolSize: 0,
          bundlePolicy: "max-bundle",
          rtcpMuxPolicy: "require",
        };
      }
      if (mode === "relay") throw new Error("relay unavailable");
      return STUN_FALLBACK;
    } catch (err) {
      if (mode === "relay") throw err;
      return STUN_FALLBACK;
    }
  }

  function getIceConfig(mode) {
    if (mode !== "relay") return fetchIceConfig(mode);
    if (!relayConfigPromise) {
      relayConfigPromise = fetchIceConfig("relay").catch((err) => {
        relayConfigPromise = null;
        throw err;
      });
    }
    return relayConfigPromise;
  }

  function prewarmRelayConfig() {
    if (relayConfigPromise) return;
    relayConfigPromise = fetchIceConfig("relay").catch((err) => {
      relayConfigPromise = null;
      throw err;
    });
    relayConfigPromise.catch(() => {});
  }

  let pc = null;
  let channel = null;
  let sendSignal = null;
  let cb = {};
  let preferredMode = "auto";
  let activeMode = "direct";
  let initiatorRole = false;
  let fallbackStarted = false;
  let fallbackTimer = 0;
  let signalChain = Promise.resolve();
  let e2eeKeyPair = null;
  let e2eePublic = "";
  let e2eeRemotePublic = "";
  let e2eeRemoteBuild = "";
  let e2eeKey = null;
  let e2eeReady = false;
  let e2eeReadyEmitted = false;
  let e2eeNoncePrefix = new Uint8Array(8);
  let e2eeSendSeq = 0;
  let e2eeSasColors = null;
  const pendingEncrypted = [];
  const canceled = new Set(); // transfer ids canceled by either side
  const incoming = new Map();
  const pendingSignals = [];

  function secureId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function b64url(bytes) {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromB64url(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{40,160}$/.test(value)) return null;
    try {
      const s = value.replace(/-/g, "+").replace(/_/g, "/");
      const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return null;
    }
  }

  async function sha256Bytes(input) {
    const bytes = typeof input === "string" ? enc.encode(input) : input;
    return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  }

  function colorsFromBytes(bytes) {
    return [0, 1, 2].map((index) => {
      const offset = index * 3;
      const hue = (bytes[offset] + bytes[offset + 1]) % 360;
      const sat = 72 + (bytes[offset + 2] % 18);
      const light = 42 + (bytes[offset + 9] % 16);
      return `${hue} ${sat}% ${light}%`;
    });
  }

  function currentBuildFingerprint() {
    const value = document.documentElement.dataset.buildFingerprint || "";
    return /^[A-F0-9]{4}-[A-F0-9]{4}$/.test(value) ? value : "";
  }

  function cleanBuildFingerprint(value) {
    return typeof value === "string" && /^[A-F0-9]{4}-[A-F0-9]{4}$/.test(value) ? value : "";
  }

  function channelOpen() {
    return channel && channel.readyState === "open";
  }
  const pendingIce = [];

  function wire(ch) {
    channel = ch;
    ch.binaryType = "arraybuffer";
    ch.bufferedAmountLowThreshold = BUFFER_LOW;
    ch.onopen = () => {
      clearFallbackTimer();
      startE2EE(ch).catch(() => closeForCryptoError());
    };
    ch.onclose = () => cb.onClose && cb.onClose();
    ch.onmessage = (ev) => handleData(ev.data);
  }

  function handleData(data) {
    if (typeof data === "string") {
      let m;
      try { m = JSON.parse(data); } catch { return; }
      if (m.t === "e2ee-hello") {
        receiveE2EEHello(m, channel).catch(() => closeForCryptoError());
      }
      return;
    }
    if (isEncryptedEnvelope(data)) {
      if (!e2eeReady) {
        if (pendingEncrypted.length >= MAX_PENDING_E2EE) return closeForCryptoError();
        pendingEncrypted.push(data);
        return;
      }
      decryptEnvelope(data).catch(() => closeForCryptoError());
    }
  }

  function handleAppMessage(m) {
    if (m.t === "msg") {
      cb.onText && cb.onText(m.text);
    } else if (m.t === "meta") {
      const meta = cleanIncomingMeta(m);
      const transfer = { id: meta.id, name: meta.name, size: meta.size, mime: meta.mime, chunks: [], received: 0 };
      incoming.set(meta.id, transfer);
      cb.onFileMeta && cb.onFileMeta(meta);
    } else if (m.t === "complete") {
      const transfer = incoming.get(m.id);
      if (transfer) {
        const blob = new Blob(transfer.chunks, { type: transfer.mime });
        cb.onFileComplete && cb.onFileComplete(transfer.id, blob, transfer.name);
        incoming.delete(m.id);
      }
    } else if (m.t === "cancel") {
      incoming.delete(m.id);
      cb.onTransferCancel && cb.onTransferCancel(m.id);
    }
  }

  function handleAppBinary(data) {
    const active = incoming.values().next().value;
    if (active) {
      active.chunks.push(data);
      active.received += data.byteLength || data.length || 0;
      cb.onFileProgress && cb.onFileProgress(active.id, active.received, active.size);
    }
  }

  async function startE2EE(ch) {
    resetE2EE();
    e2eeKeyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", e2eeKeyPair.publicKey));
    if (raw.length !== 65 || raw[0] !== 4) throw new Error("bad local key");
    e2eePublic = b64url(raw);
    if (channel !== ch || !channelOpen()) return;
    ch.send(JSON.stringify({ t: "e2ee-hello", v: 1, curve: "P-256", pub: e2eePublic, build: currentBuildFingerprint() }));
    await deriveE2EEIfReady(ch);
  }

  async function receiveE2EEHello(msg, ch) {
    if (msg.v !== 1 || msg.curve !== "P-256") throw new Error("bad e2ee hello");
    const raw = fromB64url(msg.pub);
    if (!raw || raw.length !== 65 || raw[0] !== 4) throw new Error("bad remote key");
    e2eeRemotePublic = msg.pub;
    e2eeRemoteBuild = cleanBuildFingerprint(msg.build);
    await deriveE2EEIfReady(ch);
  }

  async function deriveE2EEIfReady(ch) {
    if (e2eeReady || !e2eeKeyPair || !e2eePublic || !e2eeRemotePublic || channel !== ch || !channelOpen()) return;
    const remoteRaw = fromB64url(e2eeRemotePublic);
    if (!remoteRaw || remoteRaw.length !== 65 || remoteRaw[0] !== 4) throw new Error("bad remote key");

    const remoteKey = await crypto.subtle.importKey("raw", remoteRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: remoteKey }, e2eeKeyPair.privateKey, 256);
    const hkdfKey = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits", "deriveKey"]);
    const ordered = [e2eePublic, e2eeRemotePublic].sort().join(":");
    const salt = await sha256Bytes(`wklej-e2ee-salt-v1:${ordered}`);
    e2eeKey = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("wklej-e2ee-aes-gcm-v1") },
      hkdfKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const sas = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("wklej-e2ee-sas-v1") },
        hkdfKey,
        128,
      ),
    );
    crypto.getRandomValues(e2eeNoncePrefix);
    e2eeSendSeq = 0;
    e2eeSasColors = colorsFromBytes(sas);
    e2eeReady = true;
    await drainPendingEncrypted();
    emitSecureReady();
  }

  function emitSecureReady() {
    if (e2eeReadyEmitted || !e2eeReady) return;
    const localBuild = currentBuildFingerprint();
    if (cb.onBuild && cb.onBuild({ local: localBuild, remote: e2eeRemoteBuild, same: !!localBuild && localBuild === e2eeRemoteBuild }) === false) {
      closeForCryptoError();
      return;
    }
    e2eeReadyEmitted = true;
    if (cb.onVerify && e2eeSasColors) cb.onVerify(e2eeSasColors);
    cb.onOpen && cb.onOpen();
    emitTransport("open").catch(() => {});
    setTimeout(() => emitTransport("settled").catch(() => {}), 1200);
  }

  function isEncryptedEnvelope(data) {
    const bytes = new Uint8Array(data);
    return bytes.length >= 15 && bytes[0] === E2EE_MAGIC && (bytes[1] === E2EE_JSON || bytes[1] === E2EE_BINARY);
  }

  function nextIv() {
    const iv = new Uint8Array(12);
    iv.set(e2eeNoncePrefix, 0);
    const view = new DataView(iv.buffer);
    view.setUint32(8, e2eeSendSeq++, false);
    if (e2eeSendSeq > 0xffffffff) throw new Error("e2ee nonce exhausted");
    return iv;
  }

  async function encryptAndSend(kind, plaintext) {
    if (!channelOpen() || !e2eeReady || !e2eeKey) return false;
    const bytes = plaintext instanceof Uint8Array ? plaintext : new Uint8Array(plaintext);
    const iv = nextIv();
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, e2eeKey, bytes));
    const out = new Uint8Array(2 + iv.length + ct.length);
    out[0] = E2EE_MAGIC;
    out[1] = kind;
    out.set(iv, 2);
    out.set(ct, 14);
    channel.send(out.buffer);
    return true;
  }

  function sendEncryptedJson(msg) {
    return encryptAndSend(E2EE_JSON, enc.encode(JSON.stringify(msg)));
  }

  function sendEncryptedBinary(buffer) {
    return encryptAndSend(E2EE_BINARY, new Uint8Array(buffer));
  }

  async function decryptEnvelope(data) {
    if (!e2eeKey) throw new Error("missing e2ee key");
    const bytes = new Uint8Array(data);
    const kind = bytes[1];
    const iv = bytes.slice(2, 14);
    const ct = bytes.slice(14);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, e2eeKey, ct));
    if (kind === E2EE_JSON) {
      const msg = JSON.parse(dec.decode(plain));
      handleAppMessage(msg);
    } else if (kind === E2EE_BINARY) {
      handleAppBinary(plain.buffer);
    }
  }

  async function drainPendingEncrypted() {
    while (pendingEncrypted.length && e2eeReady) {
      await decryptEnvelope(pendingEncrypted.shift());
    }
  }

  function resetE2EE() {
    e2eeKeyPair = null;
    e2eePublic = "";
    e2eeRemotePublic = "";
    e2eeRemoteBuild = "";
    e2eeKey = null;
    e2eeReady = false;
    e2eeReadyEmitted = false;
    e2eeNoncePrefix = new Uint8Array(8);
    e2eeSendSeq = 0;
    e2eeSasColors = null;
    pendingEncrypted.length = 0;
  }

  function closeForCryptoError() {
    if (channelOpen()) {
      try { channel.close(); } catch {}
    }
    cb.onClose && cb.onClose();
  }

  async function start(initiator, signalFn, callbacks) {
    close();
    sendSignal = signalFn;
    cb = callbacks || {};
    preferredMode = localIceMode();
    activeMode = preferredMode === "auto" ? "direct" : preferredMode;
    initiatorRole = initiator;
    fallbackStarted = false;

    await createPeer(activeMode);
    if (preferredMode === "auto") prewarmRelayConfig();

    if (initiator) {
      wire(pc.createDataChannel("wklej", { ordered: true }));
      await sendOffer();
      scheduleAutoFallback();
    }

    while (pendingSignals.length) await signal(pendingSignals.shift());
  }

  async function signal(msg) {
    if (!pc) {
      pendingSignals.push(msg);
      return;
    }
    signalChain = signalChain.then(() => processSignal(msg), () => processSignal(msg));
    return signalChain;
  }

  async function processSignal(msg) {
    if (!pc) return;
    if (msg.type === "offer") {
      const remoteMode = signalIceMode(msg.iceMode);
      if (remoteMode === "relay" && activeMode !== "relay") {
        fallbackStarted = true;
        clearFallbackTimer();
        cb.onFallback && cb.onFallback("remote-relay");
        await replacePeer("relay");
      } else if (pc.remoteDescription && !isOpen() && preferredMode === "auto" && !fallbackStarted) {
        fallbackStarted = true;
        clearFallbackTimer();
        cb.onFallback && cb.onFallback("remote-offer");
        await replacePeer("relay");
      }
      await pc.setRemoteDescription(msg.sdp);
      await flushIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal({ type: "answer", sdp: pc.localDescription, iceMode: activeMode });
    } else if (msg.type === "answer") {
      await pc.setRemoteDescription(msg.sdp);
      await flushIce();
    } else if (msg.type === "ice-candidate") {
      await addIce(msg.candidate);
    }
  }

  async function createPeer(mode) {
    const config = await getIceConfig(mode);
    const next = new RTCPeerConnection(config);
    pc = next;
    activeMode = mode;
    next.onicecandidate = (ev) => {
      if (pc !== next) return;
      // In relay mode the browser is already constrained by
      // iceTransportPolicy:"relay". Do not parse/filter candidate strings here.
      if (ev.candidate) sendSignal({ type: "ice-candidate", candidate: ev.candidate });
    };
    next.onconnectionstatechange = () => {
      if (pc !== next) return;
      cb.onState && cb.onState(next.connectionState);
      if (next.connectionState === "failed") triggerTurnFallback("failed").catch(() => {});
    };
    next.ondatachannel = (ev) => {
      if (pc === next) wire(ev.channel);
    };
  }

  async function sendOffer() {
    if (!pc) return;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal({ type: "offer", sdp: pc.localDescription, iceMode: activeMode });
  }

  function scheduleAutoFallback() {
    clearFallbackTimer();
    if (preferredMode !== "auto" || !initiatorRole || fallbackStarted) return;
    fallbackTimer = setTimeout(() => triggerTurnFallback("timeout").catch(() => {}), AUTO_FALLBACK_MS);
  }

  function clearFallbackTimer() {
    if (!fallbackTimer) return;
    clearTimeout(fallbackTimer);
    fallbackTimer = 0;
  }

  function canFallback() {
    return preferredMode === "auto" && initiatorRole && !fallbackStarted && !channelOpen() && activeMode === "direct";
  }

  async function triggerTurnFallback(reason) {
    if (!canFallback()) return;
    fallbackStarted = true;
    clearFallbackTimer();
    cb.onFallback && cb.onFallback(reason || "timeout");
    await replacePeer("relay");
    if (!pc) return;
    wire(pc.createDataChannel("wklej", { ordered: true }));
    await sendOffer();
  }

  async function replacePeer(mode) {
    detachAndClose();
    pendingIce.length = 0;
    await createPeer(mode);
  }

  function detachAndClose() {
    const oldChannel = channel;
    const oldPc = pc;
    channel = null;
    pc = null;
    resetE2EE();
    if (oldChannel) {
      oldChannel.onopen = null;
      oldChannel.onclose = null;
      oldChannel.onmessage = null;
      try { oldChannel.close(); } catch {}
    }
    if (oldPc) {
      oldPc.onicecandidate = null;
      oldPc.onconnectionstatechange = null;
      oldPc.ondatachannel = null;
      try { oldPc.close(); } catch {}
    }
  }

  async function addIce(candidate) {
    if (!pc || !pc.remoteDescription) {
      pendingIce.push(candidate);
      return;
    }
    try { await pc.addIceCandidate(candidate); } catch {}
  }

  async function flushIce() {
    while (pendingIce.length) await addIce(pendingIce.shift());
  }

  async function detectTransport() {
    const base = {
      transport: "unknown",
      mode: activeMode,
      preferred: preferredMode,
      localType: "",
      remoteType: "",
      protocol: "",
      relayProtocol: "",
    };
    if (!pc) return base;

    let stats;
    try { stats = await pc.getStats(); } catch { return base; }

    let pair = null;
    stats.forEach((report) => {
      if (report.type === "transport" && report.selectedCandidatePairId && stats.get(report.selectedCandidatePairId)) {
        pair = stats.get(report.selectedCandidatePairId);
      }
    });
    if (!pair) {
      stats.forEach((report) => {
        if (
          !pair &&
          report.type === "candidate-pair" &&
          (report.selected || (report.nominated && report.state === "succeeded"))
        ) {
          pair = report;
        }
      });
    }
    if (!pair) return base;

    const local = stats.get(pair.localCandidateId) || {};
    const remote = stats.get(pair.remoteCandidateId) || {};
    const localType = local.candidateType || "";
    const remoteType = remote.candidateType || "";
    const relayUsed = localType === "relay" || remoteType === "relay";
    const known = localType || remoteType;
    const transport = relayUsed ? "relay" : known ? "direct" : "unknown";

    return {
      transport,
      mode: activeMode,
      preferred: preferredMode,
      localType,
      remoteType,
      protocol: local.protocol || remote.protocol || "",
      relayProtocol: local.relayProtocol || remote.relayProtocol || "",
    };
  }

  async function emitTransport(reason) {
    if (!cb.onTransport) return;
    const info = await detectTransport();
    cb.onTransport({ ...info, reason });
  }

  function isOpen() {
    return channelOpen() && e2eeReady;
  }

  function sendText(text) {
    if (isOpen()) sendEncryptedJson({ t: "msg", text }).catch(() => closeForCryptoError());
  }

  function drain() {
    return new Promise((resolve) => {
      if (channel.bufferedAmount <= BUFFER_HIGH) return resolve();
      const onLow = () => { channel.removeEventListener("bufferedamountlow", onLow); resolve(); };
      channel.addEventListener("bufferedamountlow", onLow);
    });
  }

  // Send one file in chunks with backpressure. Returns a transfer id.
  async function sendFile(file, hooks) {
    hooks = hooks || {};
    const id = secureId();
    if (!isOpen()) { hooks.onError && hooks.onError(id, new Error("channel closed")); return id; }

    const meta = await buildFileMeta(file);
    hooks.onStart && hooks.onStart(id, meta);
    await sendEncryptedJson({ t: "meta", id, ...meta });
    let offset = 0;
    try {
      while (offset < file.size) {
        if (canceled.has(id)) {
          await sendEncryptedJson({ t: "cancel", id });
          hooks.onCancel && hooks.onCancel(id);
          return id;
        }
        if (channel.bufferedAmount > BUFFER_HIGH) await drain();
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        const buf = await slice.arrayBuffer();
        await sendEncryptedBinary(buf);
        offset += buf.byteLength;
        hooks.onProgress && hooks.onProgress(id, offset, file.size);
      }
      await sendEncryptedJson({ t: "complete", id });
      hooks.onDone && hooks.onDone(id);
    } catch (e) {
      hooks.onError && hooks.onError(id, e);
    }
    return id;
  }

  function cleanIncomingMeta(m) {
    const name = typeof m.name === "string" && m.name.trim() ? m.name.slice(0, 240) : "plik";
    const size = Number.isFinite(Number(m.size)) && Number(m.size) >= 0 ? Number(m.size) : 0;
    const mime = typeof m.mime === "string" && m.mime.length <= 120 ? m.mime : "application/octet-stream";
    const kind = typeof m.kind === "string" ? m.kind.slice(0, 24) : fileKind(name, mime);
    const preview = safePreview(m.preview) ? m.preview : "";
    return { id: String(m.id || ""), name, size, mime, kind, preview };
  }

  async function buildFileMeta(file) {
    const mime = file.type || "application/octet-stream";
    const kind = fileKind(file.name, mime);
    const preview = kind === "image" ? await imagePreview(file) : "";
    return { name: file.name || "plik", size: file.size, mime, kind, preview };
  }

  function fileKind(name, mime) {
    const lower = String(name || "").toLowerCase();
    if (mime.startsWith("image/") && mime !== "image/svg+xml") return "image";
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

  function safePreview(value) {
    return typeof value === "string" && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value) && value.length <= 90_000;
  }

  function imagePreview(file) {
    if (!/^image\/(?:jpeg|jpg|png|webp|gif)$/i.test(file.type || "") || file.size > 20 * 1024 * 1024) {
      return Promise.resolve("");
    }
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        URL.revokeObjectURL(url);
        resolve(safePreview(value) ? value : "");
      };
      img.onload = () => {
        try {
          const max = 144;
          const scale = Math.min(1, max / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
          canvas.height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
          const ctx = canvas.getContext("2d", { alpha: false });
          if (!ctx) return finish("");
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          finish(canvas.toDataURL("image/jpeg", 0.68));
        } catch {
          finish("");
        }
      };
      img.onerror = () => finish("");
      img.src = url;
      setTimeout(() => finish(""), 1200);
    });
  }

  function cancelTransfer(id) {
    canceled.add(id);
    if (isOpen()) sendEncryptedJson({ t: "cancel", id }).catch(() => {});
  }

  function close() {
    clearFallbackTimer();
    detachAndClose();
    incoming.clear();
    pendingSignals.length = 0;
    pendingIce.length = 0;
    canceled.clear();
    signalChain = Promise.resolve();
    fallbackStarted = false;
    initiatorRole = false;
    activeMode = "direct";
    relayConfigPromise = null;
    resetE2EE();
  }

  window.__T = { start, signal, sendText, sendFile, cancelTransfer, close, isOpen, getTransport: detectTransport };
})();
