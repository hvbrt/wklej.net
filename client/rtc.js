// WebRTC P2P transport + chunked file/text transfer protocol.
// Signaling (offer/answer/ice) goes over the WS; ALL application payload (text
// and files) travels ONLY over the RTCDataChannel. The backend never sees it.

(function () {
  const STUN_FALLBACK = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
  const CHUNK_SIZE = 16 * 1024; // 16 KiB — safe across browsers incl. iOS Safari
  const BUFFER_HIGH = 8 * 1024 * 1024; // pause sending above 8 MiB buffered
  const BUFFER_LOW = 256 * 1024; // resume when drained below 256 KiB
  const AUTO_FALLBACK_MS = 6500;

  function requestedIceMode() {
    const mode = new URLSearchParams(location.search).get("ice");
    return mode === "direct" || mode === "turn" || mode === "relay" ? mode : "auto";
  }

  // Auto starts with direct STUN/P2P. TURN is introduced only if the initial
  // attempt cannot open the channel, so successful direct sessions stay fast.
  async function getIceConfig(mode) {
    try {
      const r = await fetch(`/api/ice?mode=${mode}`);
      if (!r.ok) return STUN_FALLBACK;
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
      return STUN_FALLBACK;
    } catch {
      return STUN_FALLBACK;
    }
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
  const canceled = new Set(); // transfer ids canceled by either side
  const incoming = new Map();
  const pendingSignals = [];
  const pendingIce = [];

  function wire(ch) {
    channel = ch;
    ch.binaryType = "arraybuffer";
    ch.bufferedAmountLowThreshold = BUFFER_LOW;
    ch.onopen = () => {
      clearFallbackTimer();
      cb.onOpen && cb.onOpen();
      emitTransport("open").catch(() => {});
      setTimeout(() => emitTransport("settled").catch(() => {}), 1200);
    };
    ch.onclose = () => cb.onClose && cb.onClose();
    ch.onmessage = (ev) => handleData(ev.data);
  }

  function handleData(data) {
    if (typeof data === "string") {
      let m;
      try { m = JSON.parse(data); } catch { return; }
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
      return;
    }
    // Binary chunk -> belongs to the current incoming file.
    const active = incoming.values().next().value;
    if (active) {
      active.chunks.push(data);
      active.received += data.byteLength || data.length || 0;
      cb.onFileProgress && cb.onFileProgress(active.id, active.received, active.size);
    }
  }

  async function start(initiator, signalFn, callbacks) {
    close();
    sendSignal = signalFn;
    cb = callbacks || {};
    preferredMode = requestedIceMode();
    activeMode = preferredMode === "auto" ? "direct" : preferredMode;
    initiatorRole = initiator;
    fallbackStarted = false;

    await createPeer(activeMode);

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
      if (pc.remoteDescription && !isOpen() && preferredMode === "auto" && !fallbackStarted) {
        fallbackStarted = true;
        clearFallbackTimer();
        cb.onFallback && cb.onFallback("remote-offer");
        await replacePeer("turn");
      }
      await pc.setRemoteDescription(msg.sdp);
      await flushIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal({ type: "answer", sdp: pc.localDescription });
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
    sendSignal({ type: "offer", sdp: pc.localDescription });
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
    return preferredMode === "auto" && initiatorRole && !fallbackStarted && !isOpen() && activeMode === "direct";
  }

  async function triggerTurnFallback(reason) {
    if (!canFallback()) return;
    fallbackStarted = true;
    clearFallbackTimer();
    cb.onFallback && cb.onFallback(reason || "timeout");
    await replacePeer("turn");
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
    const transport = activeMode === "relay" && relayUsed ? "relay" : relayUsed ? "turn" : known ? "direct" : "unknown";

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
    return channel && channel.readyState === "open";
  }

  function sendText(text) {
    if (isOpen()) channel.send(JSON.stringify({ t: "msg", text }));
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
    const id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random());
    if (!isOpen()) { hooks.onError && hooks.onError(id, new Error("channel closed")); return id; }

    const meta = await buildFileMeta(file);
    hooks.onStart && hooks.onStart(id, meta);
    channel.send(JSON.stringify({ t: "meta", id, ...meta }));
    let offset = 0;
    try {
      while (offset < file.size) {
        if (canceled.has(id)) {
          channel.send(JSON.stringify({ t: "cancel", id }));
          hooks.onCancel && hooks.onCancel(id);
          return id;
        }
        if (channel.bufferedAmount > BUFFER_HIGH) await drain();
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        const buf = await slice.arrayBuffer();
        channel.send(buf);
        offset += buf.byteLength;
        hooks.onProgress && hooks.onProgress(id, offset, file.size);
      }
      channel.send(JSON.stringify({ t: "complete", id }));
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
    if (isOpen()) { try { channel.send(JSON.stringify({ t: "cancel", id })); } catch {} }
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
  }

  window.__T = { start, signal, sendText, sendFile, cancelTransfer, close, isOpen, getTransport: detectTransport };
})();
