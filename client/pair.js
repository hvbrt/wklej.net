// Pairing picker: spatial first move (emoji id + drop cell), then two clicks.
// It sends only ids and position to the Worker; it derives no hashes or keys.

(function () {
  const grid = document.getElementById("emoji-grid");
  const crumb = document.getElementById("pair-crumb");
  const backBtn = document.getElementById("pair-back");
  const pairMeta = crumb ? crumb.closest(".pair-meta") : null;
  const nearby = document.getElementById("nearby-assist");
  const nearbyText = document.getElementById("nearby-text");
  const nearbyList = document.getElementById("nearby-list");
  const nearbyInvite = document.getElementById("nearby-invite");
  const TAP_MOVE_PX = 10;
  const NEARBY_INTERVAL_MS = 5000;
  const MANUAL_HINT_AFTER_MS = 11000;
  const DEVICE_FRESH_MS = 15000;

  let first = null;
  let ids = [];
  let glyphs = [];
  let bucket = null;
  let done = null;
  let busy = false;
  let seq = 0;
  let transitionTimer = 0;
  let nearbyTimer = 0;
  let nearbyKickTimer = 0;
  let nearbyStartedAt = 0;
  let wrongTimer = 0;
  let nearbyId = "";
  let activeGlobe = null;
  let activeGuide = null;
  let activeInviteId = "";
  const seenInvites = new Set();
  const nearbyDrafts = new Map();

  function shuffle(arr) {
    const out = arr.slice();
    const random = new Uint32Array(out.length);
    crypto.getRandomValues(random);
    for (let i = out.length - 1; i > 0; i--) {
      const j = random[i] % (i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  function storageKey(activeBucket, scope) {
    return `wklej-layout:${activeBucket}:${scope}`;
  }

  function readPreviousLayout(activeBucket, scope, size) {
    try {
      const raw = sessionStorage.getItem(storageKey(activeBucket, scope));
      const parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed) && parsed.length === size && parsed.every((n) => Number.isInteger(n)) ? parsed : null;
    } catch {
      return null;
    }
  }

  function saveLayout(activeBucket, scope, layout) {
    try {
      sessionStorage.setItem(storageKey(activeBucket, scope), JSON.stringify(layout));
    } catch {}
  }

  function displayLayout(size, activeBucket, scope) {
    const base = Array.from({ length: size }, (_, i) => i);
    const prev = readPreviousLayout(activeBucket, scope, size);
    if (!prev) {
      const layout = shuffle(base);
      saveLayout(activeBucket, scope, layout);
      return layout;
    }

    for (let i = 0; i < 24; i++) {
      const layout = shuffle(base);
      if (layout.every((optionIndex, cellIndex) => optionIndex !== prev[cellIndex])) {
        saveLayout(activeBucket, scope, layout);
        return layout;
      }
    }

    const layout = prev.slice(1).concat(prev[0]);
    saveLayout(activeBucket, scope, layout);
    return layout;
  }

  function renderCrumb() {
    if (crumb) crumb.textContent = glyphs.length ? glyphs.join("  ") : "";
    if (pairMeta) pairMeta.hidden = glyphs.length === 0;
    if (backBtn) backBtn.hidden = !first;
  }

  function prepareGrid(moveMode, level) {
    clearTimeout(transitionTimer);
    grid.className = "grid grid-loading";
  }

  function revealGrid(moveMode, level) {
    clearTimeout(transitionTimer);
    grid.className = "grid grid-enter";
    transitionTimer = setTimeout(() => grid.classList.remove("grid-enter"), 680);
  }

  function clearGrid() {
    destroyGlobe();
    grid.textContent = "";
  }

  function destroyGlobe() {
    if (!activeGlobe) return;
    activeGlobe.destroy();
    activeGlobe = null;
  }

  function renderEmojiGlobe(items, level, moveMode) {
    clearGrid();

    const shell = document.createElement("div");
    shell.className = "emoji-globe-shell";

    const canvas = document.createElement("canvas");
    canvas.className = "emoji-globe";
    canvas.setAttribute("aria-label", moveMode ? "emoji pairing globe" : "choose next emoji");
    canvas.setAttribute("role", "img");

    const speedRing = document.createElement("div");
    speedRing.className = "emoji-globe-speed-ring";
    speedRing.setAttribute("aria-hidden", "true");

    shell.appendChild(canvas);
    shell.appendChild(speedRing);
    grid.appendChild(shell);

    activeGlobe = createEmojiGlobe(canvas, speedRing, items, {
      level,
      moveMode,
      onFirst: (hit, target) => {
        const pos = target ? target.item.pos : hit.item.tapPos;
        commitFirst(hit.item.id, pos, hit.item.symbol, { globeKey: hit.key, globeId: hit.item.id });
      },
      onPick: (hit) => pick({ id: hit.item.id, symbol: hit.item.symbol }, { globeKey: hit.key, globeId: hit.item.id }),
    });
  }

  function createEmojiGlobe(canvas, speedRing, items, opts) {
    const ctx = canvas.getContext("2d", { alpha: true });
    const level = opts.level || 0;
    const moveMode = !!opts.moveMode;
    const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const phi = Math.PI * (3 - Math.sqrt(5));
    const visualCount = 280;
    const base = new Float32Array(visualCount * 3);
    const visualItems = new Array(visualCount);
    const projected = Array.from({ length: visualCount }, () => ({
      item: null,
      key: 0,
      x: 0,
      y: 0,
      z: 0,
      scale: 1,
      alpha: 1,
      r: 16,
      visible: false,
    }));
    const visible = [];

    for (let index = 0; index < visualCount; index++) {
      const n = Math.max(1, visualCount);
      const y = 1 - (index / Math.max(1, n - 1)) * 2;
      const ring = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = phi * index + level * 0.95;
      const itemIndex = items.length ? index % items.length : 0;
      base[index * 3] = Math.cos(theta) * ring;
      base[index * 3 + 1] = y;
      base[index * 3 + 2] = Math.sin(theta) * ring;
      visualItems[index] = items[itemIndex];
    }

    let width = 280;
    let height = 280;
    let dpr = 1;
    let rx = 0.34 + level * 0.22;
    let ry = level * 1.18;
    let velRX = 0;
    let velRY = 0;
    let raf = 0;
    let running = true;
    let selectedKey = 0;
    let missKey = 0;
    let hoverKey = 0;
    let pointer = null;
    let ghost = null;
    let ringOn = false;
    const friction = 0.92;
    const sensitivity = 0.006;

    function resize() {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(240, rect.width || 280);
      height = Math.max(240, rect.height || width);
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function drawShell(cx, cy, radius) {
      const glow = ctx.createRadialGradient(cx - radius * 0.28, cy - radius * 0.35, radius * 0.06, cx, cy, radius * 1.02);
      glow.addColorStop(0, "rgba(255,255,255,.22)");
      glow.addColorStop(0.28, "rgba(111,143,255,.12)");
      glow.addColorStop(0.66, "rgba(20,24,43,.05)");
      glow.addColorStop(1, "rgba(20,24,43,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 1.02, 0, Math.PI * 2);
      ctx.fill();

      ctx.save();
      ctx.globalAlpha = 0.14;
      ctx.strokeStyle = "rgba(196,213,255,.56)";
      ctx.lineWidth = 1;
      for (let i = -2; i <= 2; i++) {
        ctx.beginPath();
        ctx.ellipse(cx, cy + i * radius * 0.18, radius * (0.82 - Math.abs(i) * 0.09), radius * 0.14, ry * 0.35, 0, Math.PI * 2);
        ctx.stroke();
      }
      for (let i = -2; i <= 2; i++) {
        ctx.beginPath();
        ctx.ellipse(cx + i * radius * 0.12, cy, radius * 0.16, radius * 0.82, ry * 0.5, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    function frame() {
      if (!running) return;
      raf = requestAnimationFrame(frame);
      if (!reduceMotion && !pointer) {
        const moving = Math.abs(velRY) > 0.0003 || Math.abs(velRX) > 0.0003;
        if (moving) {
          ry += velRY;
          rx += velRX;
          velRY *= friction;
          velRX *= friction;
        } else {
          ry += 0.003 + level * 0.0008;
          rx += 0.0004;
          velRY = 0;
          velRX = 0;
        }
      }

      const speed = Math.hypot(velRY, velRX);
      const wantRing = speed > 0.018;
      if (speedRing && wantRing !== ringOn) {
        speedRing.classList.toggle("on", wantRing);
        ringOn = wantRing;
      }

      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, width, height);
      const cx = width / 2;
      const cy = height / 2;
      const radius = Math.min(width, height) * 0.457;
      const fov = radius * 1.95;

      drawShell(cx, cy, radius);

      const cosX = Math.cos(rx);
      const sinX = Math.sin(rx);
      const cosY = Math.cos(ry);
      const sinY = Math.sin(ry);
      visible.length = 0;

      for (let index = 0; index < visualCount; index++) {
        const bx = base[index * 3];
        const by = base[index * 3 + 1];
        const bz = base[index * 3 + 2];
        const y1 = by * cosX - bz * sinX;
        const z1 = by * sinX + bz * cosX;
        const x2 = bx * cosY + z1 * sinY;
        const z2 = -bx * sinY + z1 * cosY;
        const p = projected[index];
        p.visible = false;
        if (z2 > 0.72) continue;

        const scale = fov / (fov + z2 * radius);
        const x = x2 * radius * scale + cx;
        const y = y1 * radius * scale + cy;
        const depthAlpha = z2 <= 0 ? 1 : Math.max(0.3, 1 - z2 * 0.8);
        const edgeDist = Math.hypot((x - cx) / radius, (y - cy) / radius);
        const t = Math.min(1, Math.max(0, (edgeDist - 0.75) / 0.25));
        const edgeAlpha = 1 - t * t * (3 - 2 * t);

        p.item = visualItems[index];
        p.key = index + 1;
        p.x = x;
        p.y = y;
        p.z = z2;
        p.scale = scale;
        p.alpha = depthAlpha * edgeAlpha;
        p.r = Math.max(14, Math.round(32 * scale) * 0.72);
        p.visible = !!p.item && p.alpha >= 0.01;
        if (p.visible) visible.push(p);
      }

      visible.sort((a, b) => b.z - a.z);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.shadowBlur = 0;
      ctx.shadowColor = "transparent";

      let lastFontSize = -1;
      for (const p of visible) {
        if (!p.item) continue;

        const isSelected = selectedKey === p.key;
        const isMiss = missKey === p.key;
        const isHover = hoverKey === p.key;
        const baseSize = Math.max(7, Math.round(32 * p.scale));
        const size = Math.round(isSelected || isMiss || isHover ? baseSize * 1.18 : baseSize);

        if (isHover || isSelected || isMiss) {
          ctx.save();
          ctx.globalAlpha = isMiss ? 0.72 : isSelected ? 0.6 : 0.3;
          ctx.fillStyle = isMiss ? "rgba(239,68,68,.22)" : "rgba(255,255,255,.22)";
          ctx.strokeStyle = isMiss ? "rgba(239,68,68,.8)" : "rgba(200,218,255,.7)";
          ctx.lineWidth = isSelected ? 2 : 1;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r * 1.28, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }

        ctx.globalAlpha = p.alpha;
        if (size !== lastFontSize) {
          ctx.font = `${size}px sans-serif`;
          lastFontSize = size;
        }
        ctx.fillText(p.item.symbol, p.x, p.y);
      }
      ctx.globalAlpha = 1;
    }

    function localPoint(ev) {
      const rect = canvas.getBoundingClientRect();
      return {
        x: ev.clientX - rect.left,
        y: ev.clientY - rect.top,
      };
    }

    function hitTest(x, y) {
      return projected
        .slice()
        .sort((a, b) => a.z - b.z)
        .find((p) => p.visible && Math.hypot(p.x - x, p.y - y) <= p.r * 1.65);
    }

    function makeGhost(hit, ev) {
      ghost = document.createElement("div");
      ghost.className = "drag-ghost";
      ghost.textContent = hit.item.symbol;
      document.body.appendChild(ghost);
      moveGhost(ev);
    }

    function moveGhost(ev) {
      if (!ghost) return;
      ghost.style.left = ev.clientX + "px";
      ghost.style.top = ev.clientY + "px";
    }

    function clearPointer() {
      hoverKey = 0;
      pointer = null;
      if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
      ghost = null;
    }

    function onPointerDown(ev) {
      if (busy) return;
      const pt = localPoint(ev);
      const hit = hitTest(pt.x, pt.y);
      pointer = {
        id: ev.pointerId,
        mode: moveMode && hit ? "first-drag" : hit ? "press" : "rotate",
        hit,
        startX: ev.clientX,
        startY: ev.clientY,
        prevX: ev.clientX,
        prevY: ev.clientY,
        prevTime: performance.now(),
        dragVX: 0,
        dragVY: 0,
      };
      velRX = 0;
      velRY = 0;
      if (hit) hoverKey = hit.key;
      if (moveMode && hit) makeGhost(hit, ev);
      try {
        canvas.setPointerCapture(ev.pointerId);
      } catch {}
      ev.preventDefault();
    }

    function onPointerMove(ev) {
      if (!pointer) return;
      const moved = Math.hypot(ev.clientX - pointer.startX, ev.clientY - pointer.startY);
      if (pointer.mode === "press" && moved > TAP_MOVE_PX) pointer.mode = "rotate";

      if (pointer.mode === "rotate") {
        const now = performance.now();
        const dt = Math.max(1, now - pointer.prevTime);
        const dx = ev.clientX - pointer.prevX;
        const dy = ev.clientY - pointer.prevY;
        pointer.dragVX = (dx / dt) * 16;
        pointer.dragVY = (dy / dt) * 16;
        pointer.prevTime = now;
        ry += dx * sensitivity;
        rx += dy * sensitivity;
        hoverKey = 0;
      } else if (pointer.mode === "first-drag") {
        moveGhost(ev);
        const pt = localPoint(ev);
        const target = hitTest(pt.x, pt.y);
        hoverKey = target ? target.key : pointer.hit.key;
      }
      pointer.prevX = ev.clientX;
      pointer.prevY = ev.clientY;
      ev.preventDefault();
    }

    function onPointerUp(ev) {
      if (!pointer) return;
      const pt = localPoint(ev);
      const target = hitTest(pt.x, pt.y);
      const moved = Math.hypot(ev.clientX - pointer.startX, ev.clientY - pointer.startY);
      const current = pointer;
      clearPointer();

      if (current.mode === "first-drag" && current.hit) {
        opts.onFirst(current.hit, moved <= TAP_MOVE_PX ? null : target || null);
        return;
      }
      if (current.mode === "rotate") {
        velRY = current.dragVX * sensitivity;
        velRX = current.dragVY * sensitivity;
        return;
      }
      if (current.mode === "press" && current.hit && moved <= TAP_MOVE_PX) {
        opts.onPick(current.hit);
      }
    }

    function onResize() {
      resize();
    }

    resize();
    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("resize", onResize);
    raf = requestAnimationFrame(frame);

    return {
      setSelected(id) {
        selectedKey = id;
      },
      flashMiss(id) {
        missKey = id;
        setTimeout(() => {
          if (missKey === id) missKey = 0;
        }, 420);
      },
      destroy() {
        running = false;
        cancelAnimationFrame(raf);
        clearPointer();
        if (speedRing) speedRing.classList.remove("on");
        canvas.removeEventListener("pointerdown", onPointerDown);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("resize", onResize);
      },
    };
  }

  function deviceId() {
    if (nearbyId) return nearbyId;
    try {
      nearbyId = sessionStorage.getItem("wklej-nearby-id") || "";
      if (!nearbyId) {
        nearbyId = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random());
        sessionStorage.setItem("wklej-nearby-id", nearbyId);
      }
    } catch {
      nearbyId = String(Date.now() + Math.random());
    }
    return nearbyId;
  }

  function deviceLabel() {
    const suffix = deviceId().replace(/[^a-z0-9]/gi, "").slice(0, 4).toUpperCase();
    return `${deviceProfile()} ${suffix}`.trim();
  }

  function deviceProfile() {
    const ua = navigator.userAgent || "";
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    let device = "urządzenie";
    if (/iphone/i.test(ua)) device = "iPhone";
    else if (/ipad/i.test(ua) || (/mac/i.test(platform) && navigator.maxTouchPoints > 1)) device = "iPad";
    else if (/android/i.test(ua)) device = "Android";
    else if (/mac/i.test(platform)) device = "Mac";
    else if (/win/i.test(platform)) device = "Windows";
    else if (/linux/i.test(platform)) device = "Linux";

    let browser = "";
    if (/edg\//i.test(ua)) browser = "Edge";
    else if (/firefox\//i.test(ua)) browser = "Firefox";
    else if (/crios\//i.test(ua) || (/chrome\//i.test(ua) && !/opr\//i.test(ua))) browser = "Chrome";
    else if (/safari\//i.test(ua)) browser = "Safari";
    return `${device}${browser ? " " + browser : ""}`;
  }

  function randomIndex(length) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] % length;
  }

  async function sendNearby(present) {
    if (!nearby || !nearbyText) return;
    try {
      const res = await fetch("/api/nearby", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: deviceId(), label: deviceLabel(), present }),
      });
      if (!res.ok || !present) return;
      const d = await res.json();
      updateNearby(d);
    } catch {}
  }

  function deviceWord(count) {
    return count === 1 ? "device" : "devices";
  }

  function updateNearby(d) {
    const devices = freshDevices(Array.isArray(d.devices) ? d.devices : []);
    const invites = Array.isArray(d.invites) ? d.invites : [];
    const count = devices.length;
    const privateRelay = !!(d.privacy && d.privacy.privateRelayLikely && count === 0);
    const manualFallback = !privateRelay && count === 0 && invites.length === 0 && Date.now() - nearbyStartedAt >= MANUAL_HINT_AFTER_MS;
    const manualMode = privateRelay || manualFallback;

    nearby.hidden = false;
    nearby.classList.toggle("active", count > 0 || invites.length > 0);
    nearby.classList.toggle("nearby-manual", manualMode);
    nearby.classList.toggle("nearby-privacy", privateRelay);
    if (privateRelay) {
      nearbyText.textContent = "manual: Private Relay/VPN";
    } else if (manualFallback) {
      nearbyText.textContent = "manual ready";
    } else {
      nearbyText.textContent = count > 0 ? `nearby: ${count} ${deviceWord(count)}` : "nearby";
    }

    renderNearbyDevices(devices);
    if (privateRelay) renderManualCard("privacy");
    else if (manualFallback) renderManualCard("timeout");
    renderIncomingInvite(invites);
  }

  function freshDevices(devices) {
    return devices
      .filter((x) => x && typeof x.id === "string")
      .map((x) => ({ ...x, ageMs: Number.isFinite(Number(x.ageMs)) ? Number(x.ageMs) : 0 }))
      .filter((x) => x.ageMs <= DEVICE_FRESH_MS)
      .sort((a, b) => a.ageMs - b.ageMs);
  }

  function renderNearbyDevices(devices) {
    if (!nearbyList) return;
    nearbyList.textContent = "";
    if (activeGuide) return;
    for (const device of devices.slice(0, 3)) {
      const label = String(device.label || "urządzenie obok");
      const kind = deviceKind(label);
      const draft = nearbyDraft(device.id);
      const row = document.createElement("div");
      row.className = `nearby-device ${kind === "phone" ? "phone" : "computer"}`;
      row.addEventListener("click", (ev) => {
        if (ev.target && ev.target.closest && ev.target.closest(".nearby-composer")) return;
        startNearbySend(device);
      });

      const deviceButton = document.createElement("button");
      deviceButton.type = "button";
      deviceButton.className = "nearby-device-main nearby-device-action";
      deviceButton.setAttribute("aria-label", `połącz z ${label}`);
      deviceButton.addEventListener("click", (ev) => {
        ev.stopPropagation();
        startNearbySend(device);
      });

      const avatar = document.createElement("div");
      avatar.className = "nearby-avatar";
      avatar.textContent = kind === "phone" ? "📱" : "💻";

      const main = document.createElement("div");
      main.className = "nearby-main";
      const name = document.createElement("div");
      name.className = "nearby-name";
      const labelText = document.createElement("span");
      labelText.className = "nearby-label-text";
      labelText.textContent = label;
      name.appendChild(labelText);
      main.appendChild(name);

      deviceButton.appendChild(avatar);
      deviceButton.appendChild(main);
      row.appendChild(deviceButton);
      row.appendChild(renderNearbyComposer(device, draft));
      nearbyList.appendChild(row);
    }
  }

  function nearbyDraft(id) {
    if (!nearbyDrafts.has(id)) nearbyDrafts.set(id, { file: null, text: "" });
    return nearbyDrafts.get(id);
  }

  function renderNearbyComposer(device, draft) {
    const wrap = document.createElement("div");
    wrap.className = "nearby-composer";
    wrap.addEventListener("click", (ev) => ev.stopPropagation());

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.hidden = true;

    const textShell = document.createElement("div");
    textShell.className = "nearby-text-shell";

    const text = document.createElement("input");
    text.type = "text";
    text.className = "nearby-txt";
    text.placeholder = "";
    text.value = draft.text || "";
    text.autocomplete = "off";
    text.setAttribute("aria-label", "text to send");

    const action = document.createElement("button");
    action.type = "button";
    action.className = "nearby-quick";

    const sync = () => {
      const ready = !!draft.file || !!String(draft.text || "").trim();
      textShell.classList.toggle("has-value", ready);
      action.classList.toggle("ready", ready);
      action.textContent = ready ? "↑" : "+";
      action.title = ready ? "send" : "attach file";
      action.setAttribute("aria-label", ready ? "send" : "attach file");
      text.classList.toggle("has-file", !!draft.file);
      if (draft.file && !draft.text) text.placeholder = draft.file.name.slice(0, 24);
      else text.placeholder = "";
    };

    fileInput.addEventListener("change", () => {
      draft.file = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
      if (draft.file) draft.text = "";
      text.value = draft.text;
      sync();
    });

    text.addEventListener("input", () => {
      draft.text = text.value;
      if (draft.text.trim()) draft.file = null;
      sync();
    });
    text.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        const payload = nearbyPayload(draft);
        if (payload) startNearbySend(device, payload);
      }
    });

    action.addEventListener("click", () => {
      const payload = nearbyPayload(draft);
      if (!payload) {
        fileInput.click();
        return;
      }
      startNearbySend(device, payload);
    });

    sync();
    const marquee = document.createElement("span");
    marquee.className = "nearby-marquee";
    marquee.textContent = "W K L E J";
    textShell.appendChild(text);
    textShell.appendChild(marquee);
    wrap.appendChild(textShell);
    wrap.appendChild(fileInput);
    wrap.appendChild(action);
    return wrap;
  }

  function nearbyPayload(draft) {
    if (draft.file) return { kind: "file", file: draft.file };
    const text = String(draft.text || "").trim();
    if (text) return { kind: "text", text };
    return null;
  }

  function deviceKind(label) {
    return /iphone|android|phone|ipad|mobile/i.test(label) ? "phone" : "computer";
  }

  function renderManualCard(reason) {
    if (!nearbyList || activeGuide) return;
    const row = document.createElement("div");
    row.className = "nearby-device manual";

    const avatar = document.createElement("div");
    avatar.className = "nearby-avatar";
    avatar.textContent = "↯";

    const main = document.createElement("div");
    main.className = "nearby-main";
    const name = document.createElement("div");
    name.className = "nearby-name";
    name.textContent = reason === "privacy" ? "nearby hidden" : "no nearby device";
    const sub = document.createElement("div");
    sub.className = "nearby-sub";
    sub.textContent =
      reason === "privacy"
        ? "use the same emoji manually or disable Private Relay/VPN for this site"
        : "open wklej.net on the other device and choose the same emoji";
    main.appendChild(name);
    main.appendChild(sub);

    row.appendChild(avatar);
    row.appendChild(main);
    nearbyList.appendChild(row);
  }

  function renderIncomingInvite(invites) {
    if (!nearbyInvite || activeGuide) return;
    const invite = invites.find((item) => item && !seenInvites.has(item.id) && isInviteSelection(item.selection));
    if (!invite) {
      nearbyInvite.hidden = true;
      nearbyInvite.textContent = "";
      return;
    }

    activeInviteId = invite.id;
    seenInvites.add(invite.id);

    if (invite.mode === "send") {
      acceptNearbySendInvite(invite);
      return;
    }

    activeGuide = invite.selection;
    nearbyInvite.hidden = false;
    nearbyInvite.textContent = "";

    const card = document.createElement("div");
    card.className = "nearby-invite-card";
    const avatar = document.createElement("div");
    avatar.className = "nearby-avatar";
    avatar.textContent = "✓";
    const main = document.createElement("div");
    main.className = "nearby-main";
    const name = document.createElement("div");
    name.className = "nearby-name";
    name.textContent = `${invite.fromLabel || "nearby device"} invites`;
    const sub = document.createElement("div");
    sub.className = "nearby-sub";
    sub.textContent = "take these emoji";
    const seqEl = document.createElement("div");
    seqEl.className = "nearby-seq";
    fillSequence(seqEl, activeGuide.glyphs, 0);
    main.appendChild(name);
    main.appendChild(sub);
    main.appendChild(seqEl);
    card.appendChild(avatar);
    card.appendChild(main);
    nearbyInvite.appendChild(card);
    if (nearbyList) nearbyList.textContent = "";
    renderPalette();
  }

  async function acceptNearbySendInvite(invite) {
    if (!nearbyInvite || !done) return;
    const fromLabel = invite.fromLabel || "urządzenie obok";
    nearbyInvite.hidden = true;
    nearbyInvite.textContent = "";
    if (nearbyList) nearbyList.textContent = "";
    if (nearbyText) nearbyText.textContent = "";

    const selection = {
      first: invite.selection.first,
      rest: invite.selection.rest.slice(),
      bucket: invite.selection.bucket,
      expectPeer: true,
    };
    await dismissInvite();
    stopNearby(false);
    const cb = done;
    done = null;
    if (cb) cb(selection, `od ${fromLabel}`, { nearbySend: true, direction: "receive", fromLabel });
  }

  function guideIndex() {
    if (!activeGuide) return -1;
    if (!first) return 0;
    return Math.min(ids.length + 1, activeGuide.glyphs.length - 1);
  }

  function fillSequence(el, items, activeIndex) {
    el.textContent = "";
    items.forEach((glyph, index) => {
      const item = document.createElement("span");
      item.className = "nearby-seq-item";
      if (index < activeIndex) item.classList.add("done");
      if (index === activeIndex) item.classList.add("active");
      item.textContent = `${index + 1}. ${glyph}`;
      el.appendChild(item);
    });
  }

  function renderGuideSequence() {
    if (!activeGuide || !nearbyInvite) return;
    const seqEl = nearbyInvite.querySelector(".nearby-seq");
    if (seqEl) fillSequence(seqEl, activeGuide.glyphs, guideIndex());
  }

  function isInviteSelection(value) {
    return (
      value &&
      value.first &&
      Number.isInteger(value.first.id) &&
      Number.isInteger(value.first.pos) &&
      Number.isInteger(value.bucket) &&
      Array.isArray(value.rest) &&
      value.rest.length === 2 &&
      Array.isArray(value.glyphs) &&
      value.glyphs.length === 3
    );
  }

  function startNearby() {
    if (!nearby) return;
    stopNearby(false);
    nearby.hidden = false;
    nearby.classList.remove("active");
    nearby.classList.remove("nearby-manual");
    if (nearbyText) nearbyText.textContent = "nearby";
    nearbyStartedAt = Date.now();
    sendNearby(true);
    nearbyKickTimer = setTimeout(() => sendNearby(true), 1200);
    nearbyTimer = setInterval(() => sendNearby(true), NEARBY_INTERVAL_MS);
  }

  function stopNearby(notify) {
    if (nearbyTimer) clearInterval(nearbyTimer);
    if (nearbyKickTimer) clearTimeout(nearbyKickTimer);
    nearbyTimer = 0;
    nearbyKickTimer = 0;
    if (nearby) {
      nearby.hidden = true;
      nearby.classList.remove("active");
      nearby.classList.remove("nearby-manual");
      nearby.classList.remove("nearby-privacy");
    }
    nearbyStartedAt = 0;
    if (nearbyList) nearbyList.textContent = "";
    if (notify) sendNearby(false);
  }

  async function sendInvite(to, selection, mode) {
    const res = await fetch("/api/nearby", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "invite",
        id: deviceId(),
        label: deviceLabel(),
        present: true,
        to,
        selection,
        mode: mode || "pair",
      }),
    });
    return res.ok ? res.json() : { ok: false };
  }

  async function dismissInvite() {
    if (!activeInviteId) return;
    const inviteId = activeInviteId;
    activeInviteId = "";
    try {
      await fetch("/api/nearby", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dismiss", id: deviceId(), label: deviceLabel(), present: true, inviteId }),
      });
    } catch {}
  }

  async function startNearbySend(device, payload) {
    if (busy || !done) return;
    busy = true;
    const targetLabel = String(device.label || "urządzenie obok");
    nearbyText.textContent = "creating";
    try {
      const selection = await randomSelection();
      const res = await sendInvite(device.id, selection, "send");
      if (res && res.ok === false) {
        nearbyText.textContent = "lost";
        busy = false;
        return;
      }
      stopNearby(false);
      const cb = done;
      done = null;
      if (cb) cb(selection, `do ${targetLabel}`, { nearbySend: true, direction: "send", targetLabel, payload: payload || null });
    } catch {
      nearbyText.textContent = "failed";
      busy = false;
    }
  }

  async function randomSelection() {
    const firstLevel = await fetchTree(null, [], null);
    const firstIndex = randomIndex(firstLevel.options.length);
    const firstEmoji = firstLevel.options[firstIndex];
    const firstMove = { id: firstEmoji.id, pos: firstIndex + 1 };

    const secondLevel = await fetchTree(firstMove, [], firstLevel.bucket);
    const secondEmoji = secondLevel.options[randomIndex(secondLevel.options.length)];

    const thirdLevel = await fetchTree(firstMove, [secondEmoji.id], firstLevel.bucket);
    const thirdEmoji = thirdLevel.options[randomIndex(thirdLevel.options.length)];

    return {
      first: firstMove,
      rest: [secondEmoji.id, thirdEmoji.id],
      bucket: firstLevel.bucket,
      glyphs: [firstEmoji.symbol, secondEmoji.symbol, thirdEmoji.symbol],
    };
  }

  async function renderPalette() {
    const run = ++seq;
    first = null;
    ids = [];
    glyphs = [];
    bucket = null;
    renderCrumb();
    prepareGrid(true, 0);

    let d;
    try {
      d = await fetchTree(null, [], activeGuide ? activeGuide.bucket : null);
    } catch {
      if (run !== seq) return;
      showGridError("network error");
      return;
    }
    if (run !== seq) return;
    if (!d || !d.ok || !Array.isArray(d.options) || !Number.isInteger(d.bucket)) {
      showGridError("expired");
      return;
    }
    bucket = d.bucket;

    const layout = displayLayout(d.options.length, bucket, "1");
    const items = layout.map((optionIndex, cellIndex) => {
      const e = d.options[optionIndex];
      return {
        id: e.id,
        symbol: e.symbol,
        tapPos: optionIndex + 1,
        pos: cellIndex + 1,
        slot: cellIndex,
      };
    });
    renderEmojiGlobe(items, 0, true);
    revealGrid(true, 0);
  }

  function cleanupDrag() {
    grid.classList.remove("dragging");
  }

  function flashWrong(btn, text) {
    if (nearbyText) nearbyText.textContent = text;
    clearTimeout(wrongTimer);
    grid.classList.add("pair-wrong");
    if (activeGlobe && btn && Number.isInteger(btn.globeKey)) activeGlobe.flashMiss(btn.globeKey);
    if (btn && btn.classList) btn.classList.add("miss");
    wrongTimer = setTimeout(() => {
      grid.classList.remove("pair-wrong");
      if (btn && btn.classList) btn.classList.remove("miss");
    }, 420);
  }

  function commitFirst(id, pos, glyph, btn) {
    if (activeGuide && (id !== activeGuide.first.id || pos !== activeGuide.first.pos)) {
      flashWrong(btn, `kliknij 1. ${activeGuide.glyphs[0]}`);
      return;
    }
    first = { id, pos };
    glyphs = [glyph];
    ids = [];
    busy = false;
    if (activeGlobe && btn && Number.isInteger(btn.globeKey)) activeGlobe.setSelected(btn.globeKey);
    renderGuideSequence();
    step();
  }

  function fetchLevel() {
    return fetchTree(first, ids, bucket);
  }

  function fetchTree(firstMove, rest, activeBucket) {
    const params = new URLSearchParams();
    params.set("m1", firstMove ? `${firstMove.id}.${firstMove.pos}` : "");
    params.set("path", rest.join(","));
    if (activeBucket !== null && activeBucket !== undefined) params.set("b", String(activeBucket));
    return fetch(`/api/tree?${params.toString()}`).then((r) => r.json());
  }

  async function step() {
    const run = ++seq;
    renderCrumb();
    renderGuideSequence();
    const level = Math.min(2, glyphs.length);
    prepareGrid(false, level);

    let d;
    try {
      d = await fetchLevel();
    } catch {
      if (run !== seq) return;
      showGridError("network error");
      return;
    }
    if (run !== seq) return;
    if (!d || !d.ok) {
      showGridError(d && d.reason === "expired-path" ? "expired" : "failed");
      return;
    }
    if (d.complete) {
      const cb = done;
      done = null;
      destroyGlobe();
      grid.className = "grid";
      grid.textContent = "";
      const finalSelection = activeGuide
        ? { first: activeGuide.first, rest: activeGuide.rest.slice(), bucket: activeGuide.bucket, expectPeer: true }
        : { first, rest: ids.slice(), bucket };
      const finalLabel = activeGuide ? activeGuide.glyphs.join(" ") : glyphs.join(" ");
      if (activeGuide) dismissInvite();
      stopNearby(true);
      if (cb) cb(finalSelection, finalLabel);
      return;
    }
    if (!Array.isArray(d.options)) {
      showGridError("failed");
      return;
    }

    const layout = displayLayout(d.options.length, bucket, `${first.id}.${first.pos}:${ids.join(",")}`);
    const items = layout.map((optionIndex, cellIndex) => {
      const e = d.options[optionIndex];
      return {
        id: e.id,
        symbol: e.symbol,
        tapPos: optionIndex + 1,
        pos: cellIndex + 1,
        slot: cellIndex,
      };
    });
    renderEmojiGlobe(items, level, false);
    revealGrid(false, level);
  }

  function pick(e, btn) {
    if (busy) return;
    if (activeGuide && e.id !== activeGuide.rest[ids.length]) {
      flashWrong(btn, `kliknij ${ids.length + 2}. ${activeGuide.glyphs[ids.length + 1]}`);
      return;
    }
    busy = true;
    if (activeGlobe && btn && Number.isInteger(btn.globeKey)) activeGlobe.setSelected(btn.globeKey);
    if (btn && btn.classList) btn.classList.add("sel");
    ids.push(e.id);
    glyphs.push(e.symbol);
    renderGuideSequence();
    setTimeout(() => {
      busy = false;
      step();
    }, 170);
  }

  function back() {
    if (busy) return;
    if (ids.length > 0) {
      ids.pop();
      glyphs.pop();
      step();
    } else if (first) {
      renderPalette();
    }
  }

  function reset(notifyNearby) {
    seq++;
    cleanupDrag();
    first = null;
    ids = [];
    glyphs = [];
    bucket = null;
    done = null;
    busy = false;
    activeGuide = null;
    activeInviteId = "";
    nearbyDrafts.clear();
    if (grid) {
      destroyGlobe();
      grid.className = "grid";
      grid.textContent = "";
    }
    clearTimeout(wrongTimer);
    stopNearby(notifyNearby !== false);
    if (nearbyInvite) {
      nearbyInvite.hidden = true;
      nearbyInvite.textContent = "";
    }
    clearTimeout(transitionTimer);
    renderCrumb();
  }

  function begin(onComplete) {
    reset(false);
    done = onComplete;
    startNearby();
    renderPalette();
  }

  function showGridError(text) {
    destroyGlobe();
    grid.className = "grid";
    const p = document.createElement("p");
    p.className = "hint bad";
    p.textContent = text;
    grid.replaceChildren(p);
  }

  if (backBtn) backBtn.addEventListener("click", back);
  window.addEventListener("pagehide", () => stopNearby(true));
  window.__P = { begin, reset };
})();
