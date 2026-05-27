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
  const COLS = ["A", "B", "C", "D"];
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
  let drag = null;
  let seq = 0;
  let transitionTimer = 0;
  let nearbyTimer = 0;
  let nearbyKickTimer = 0;
  let nearbyStartedAt = 0;
  let wrongTimer = 0;
  let nearbyId = "";
  let activeGuide = null;
  let activeInviteId = "";
  const seenInvites = new Set();
  const nearbyDrafts = new Map();

  function coord(pos) {
    return COLS[(pos - 1) % 4] + (Math.floor((pos - 1) / 4) + 1);
  }

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

  function setGridMotion(level) {
    const patterns = [
      { gx: "34deg", gy: "-16deg", gz: "-3deg", cx: "-2deg", cy: "2deg", rx: "-54deg", ry: "24deg", rz: "6deg" },
      { gx: "-30deg", gy: "18deg", gz: "4deg", cx: "2deg", cy: "-2deg", rx: "52deg", ry: "-26deg", rz: "-7deg" },
      { gx: "24deg", gy: "31deg", gz: "-5deg", cx: "-1deg", cy: "-3deg", rx: "-42deg", ry: "-38deg", rz: "8deg" },
    ];
    const p = patterns[Math.abs(level) % patterns.length];
    grid.dataset.level = String(level);
    grid.style.setProperty("--grid-rx", p.gx);
    grid.style.setProperty("--grid-ry", p.gy);
    grid.style.setProperty("--grid-rz", p.gz);
    grid.style.setProperty("--grid-cx", p.cx);
    grid.style.setProperty("--grid-cy", p.cy);
    grid.style.setProperty("--cell-rx", p.rx);
    grid.style.setProperty("--cell-ry", p.ry);
    grid.style.setProperty("--cell-rz", p.rz);
  }

  function prepareGrid(moveMode, level) {
    clearTimeout(transitionTimer);
    setGridMotion(level || 0);
    grid.className = moveMode ? "grid grid-move grid-loading" : "grid grid-loading";
  }

  function revealGrid(moveMode, level) {
    clearTimeout(transitionTimer);
    setGridMotion(level || 0);
    grid.className = moveMode ? "grid grid-move grid-enter" : "grid grid-enter";
    transitionTimer = setTimeout(() => grid.classList.remove("grid-enter"), 680);
  }

  function setGlobeSlot(el, index, total, level) {
    const safeTotal = Math.max(1, total);
    const golden = Math.PI * (3 - Math.sqrt(5));
    const y = 1 - ((index + 0.5) / safeTotal) * 2;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * index + level * 0.92;
    let x = Math.cos(theta) * ring;
    let z = Math.sin(theta) * ring;

    const tilt = -0.22 + level * 0.16;
    const cos = Math.cos(tilt);
    const sin = Math.sin(tilt);
    const tiltedY = y * cos - z * sin;
    z = y * sin + z * cos;

    const depth = (z + 1) / 2;
    const scale = 0.68 + depth * 0.46;
    const alpha = 0.42 + depth * 0.58;

    el.style.setProperty("--i", String(index));
    el.style.setProperty("--gx", `${(x * (106 + depth * 16)).toFixed(2)}px`);
    el.style.setProperty("--gy", `${(tiltedY * 94 - z * 10).toFixed(2)}px`);
    el.style.setProperty("--gz", `${(z * 78).toFixed(2)}px`);
    el.style.setProperty("--gs", scale.toFixed(3));
    el.style.setProperty("--ga", alpha.toFixed(3));
    el.style.setProperty("--zi", String(Math.round(depth * 1000) + index));
    el.style.setProperty("--cell-dx", `${((index % 4) - 1.5) * 14}px`);
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
    grid.textContent = "";
    layout.forEach((optionIndex, cellIndex) => {
      const e = d.options[optionIndex];
      const pos = cellIndex + 1;
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.pos = String(pos);
      setGlobeSlot(cell, cellIndex, layout.length, 0);

      const tag = document.createElement("span");
      tag.className = "cell-tag";
      tag.textContent = coord(pos);

      const b = document.createElement("button");
      b.type = "button";
      b.className = "emoji-btn drag";
      b.textContent = e.symbol;
      b.dataset.id = String(e.id);
      b.dataset.tapPos = String(optionIndex + 1);
      b.addEventListener("pointerdown", (ev) => startDrag(ev, b));

      cell.appendChild(tag);
      cell.appendChild(b);
      grid.appendChild(cell);
    });
    revealGrid(true, 0);
  }

  function startDrag(ev, btn) {
    if (busy) return;
    ev.preventDefault();
    try {
      btn.setPointerCapture(ev.pointerId);
    } catch {}
    cleanupDrag();

    const ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    ghost.textContent = btn.textContent;
    document.body.appendChild(ghost);

    drag = {
      id: Number(btn.dataset.id),
      tapPos: Number(btn.dataset.tapPos || btn.closest("[data-pos]").dataset.pos),
      glyph: btn.textContent,
      btn,
      ghost,
      startX: ev.clientX,
      startY: ev.clientY,
    };
    grid.classList.add("dragging");
    moveGhost(ev.clientX, ev.clientY);
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp, { once: true });
  }

  function moveGhost(x, y) {
    if (!drag) return;
    drag.ghost.style.left = x + "px";
    drag.ghost.style.top = y + "px";
  }

  function cellUnder(x, y) {
    const el = document.elementFromPoint(x, y);
    return el && el.closest ? el.closest("[data-pos]") : null;
  }

  function onMove(ev) {
    if (!drag) return;
    ev.preventDefault();
    moveGhost(ev.clientX, ev.clientY);
    const cell = cellUnder(ev.clientX, ev.clientY);
    grid.querySelectorAll(".cell").forEach((c) => c.classList.toggle("drop-hover", c === cell));
  }

  function onUp(ev) {
    window.removeEventListener("pointermove", onMove);
    const cell = cellUnder(ev.clientX, ev.clientY);
    const d = drag;
    cleanupDrag();
    if (!d || !cell) return;
    const moved = Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY);
    commitFirst(d.id, moved <= TAP_MOVE_PX ? d.tapPos : Number(cell.dataset.pos), d.glyph, d.btn);
  }

  function cleanupDrag() {
    window.removeEventListener("pointermove", onMove);
    if (drag && drag.ghost && drag.ghost.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
    drag = null;
    grid.classList.remove("dragging");
    grid.querySelectorAll(".drop-hover").forEach((c) => c.classList.remove("drop-hover"));
  }

  function flashWrong(btn, text) {
    if (nearbyText) nearbyText.textContent = text;
    clearTimeout(wrongTimer);
    grid.classList.add("pair-wrong");
    if (btn) btn.classList.add("miss");
    wrongTimer = setTimeout(() => {
      grid.classList.remove("pair-wrong");
      if (btn) btn.classList.remove("miss");
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
      grid.className = "grid";
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
    grid.textContent = "";
    layout.forEach((optionIndex, cellIndex) => {
      const e = d.options[optionIndex];
      const b = document.createElement("button");
      b.type = "button";
      b.className = "emoji-btn";
      b.textContent = e.symbol;
      b.dataset.id = String(e.id);
      setGlobeSlot(b, cellIndex, layout.length, level);
      b.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        b.dataset.tapAt = String(Date.now());
        pick(e, b);
      });
      b.addEventListener("click", () => {
        const tapAt = Number(b.dataset.tapAt || 0);
        if (Date.now() - tapAt < 700) return;
        pick(e, b);
      });
      grid.appendChild(b);
    });
    revealGrid(false, level);
  }

  function pick(e, btn) {
    if (busy) return;
    if (activeGuide && e.id !== activeGuide.rest[ids.length]) {
      flashWrong(btn, `kliknij ${ids.length + 2}. ${activeGuide.glyphs[ids.length + 1]}`);
      return;
    }
    busy = true;
    btn.classList.add("sel");
    grid.querySelectorAll(".emoji-btn").forEach((x) => {
      if (x !== btn) x.classList.add("lock");
    });
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
