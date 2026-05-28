// Pairing picker: first tap carries emoji id + visual position, then two taps.
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
  const nameModal = document.getElementById("room-name-modal");
  const nameInput = document.getElementById("room-name-input");
  const nameStatus = document.getElementById("room-name-status");
  const nameCreate = document.getElementById("room-name-create");
  const nameJoin = document.getElementById("room-name-join");
  const nameClose = document.getElementById("room-name-close");
  const ROOM_SWIPE_MIN_RATIO = 0.58;
  const ROOM_SWIPE_CENTER_RATIO = 0.34;
  const NEARBY_INTERVAL_MS = 5000;
  const MANUAL_HINT_AFTER_MS = 11000;
  const DEVICE_FRESH_MS = 15000;
  const LEVEL_TRANSITION_DELAY_MS = 330;

  let first = null;
  let ids = [];
  let glyphs = [];
  let pickedAssets = [];
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
    if (crumb) {
      crumb.textContent = "";
      glyphs.forEach((glyph, index) => {
        const asset = pickedAssets[index];
        const el = asset ? document.createElement("img") : document.createElement("span");
        el.className = asset ? "pair-crumb-emoji" : "pair-crumb-glyph";
        if (asset) {
          el.src = asset;
          el.alt = glyph;
          el.loading = "lazy";
          el.decoding = "async";
        } else {
          el.textContent = glyph;
        }
        crumb.appendChild(el);
      });
    }
    if (pairMeta) pairMeta.hidden = glyphs.length === 0;
    if (backBtn) backBtn.hidden = !first;
  }

  function prepareGrid(moveMode, level) {
    clearTimeout(transitionTimer);
    if (activeGlobe && typeof activeGlobe.spinTransition === "function") activeGlobe.spinTransition();
    grid.className = "grid grid-loading";
  }

  function revealGrid(moveMode, level) {
    clearTimeout(transitionTimer);
    grid.className = "grid grid-enter";
    transitionTimer = setTimeout(() => grid.classList.remove("grid-enter"), 820);
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

  const FIELD_SLOTS = [
    { x: 13, y: 25 },
    { x: 33, y: 20 },
    { x: 53, y: 26 },
    { x: 75, y: 21 },
    { x: 22, y: 47 },
    { x: 43, y: 43 },
    { x: 64, y: 49 },
    { x: 84, y: 45 },
    { x: 15, y: 70 },
    { x: 37, y: 68 },
    { x: 60, y: 72 },
    { x: 79, y: 68 },
  ];

  function renderEmojiGlobe(items, level, moveMode) {
    clearGrid();

    const shell = document.createElement("div");
    shell.className = "emoji-field-shell";
    shell.style.setProperty("--field-level", String(level % 4));

    const viewport = document.createElement("div");
    viewport.className = "emoji-map-viewport";
    viewport.setAttribute("aria-label", moveMode ? "emoji pairing map" : "choose next emoji");
    viewport.setAttribute("role", "group");

    const track = document.createElement("div");
    track.className = "emoji-map-track";
    track.setAttribute("aria-hidden", "true");

    const shimmer = document.createElement("div");
    shimmer.className = "emoji-map-shimmer";
    shimmer.setAttribute("aria-hidden", "true");

    const picker = document.createElement("div");
    picker.className = "emoji-map-picks";

    viewport.appendChild(track);
    viewport.appendChild(shimmer);
    viewport.appendChild(picker);
    shell.appendChild(viewport);
    grid.appendChild(shell);

    activeGlobe = createEmojiField(viewport, picker, items, {
      level,
      moveMode,
      onFirst: (hit, target) => {
        const pos = target ? target.item.pos : hit.item.tapPos;
        commitFirst(hit.item.id, pos, hit.item.symbol, hit.item.asset, hit.button);
      },
      onPick: (hit) => pick({ id: hit.item.id, symbol: hit.item.symbol, asset: hit.item.asset }, hit.button),
      onRoomSwipe: showNameRoomModal,
    });
    if (!moveMode && level > 0 && typeof activeGlobe.spinTransition === "function") activeGlobe.spinTransition();
  }

  function createEmojiField(viewport, picker, items, opts) {
    const buttons = new Map();
    const sourceItems = items.slice(0, FIELD_SLOTS.length);
    let destroyed = false;
    let selectedKey = 0;
    let missTimer = 0;
    let switchTimer = 0;
    let pointer = null;
    let suppressClickUntil = 0;

    sourceItems.forEach((item, index) => {
      const key = index + 1;
      const slot = FIELD_SLOTS[index % FIELD_SLOTS.length];
      const button = document.createElement("button");
      button.type = "button";
      button.className = "emoji-map-pick";
      button.globeKey = key;
      button.style.setProperty("--x", `${slot.x}%`);
      button.style.setProperty("--y", `${slot.y}%`);
      button.style.setProperty("--d", `${index * 28}ms`);
      button.setAttribute("aria-label", `choose ${item.symbol}`);

      if (item.asset) {
        const img = document.createElement("img");
        img.src = item.asset;
        img.alt = item.symbol;
        img.decoding = "async";
        img.loading = "eager";
        button.appendChild(img);
      } else {
        const glyph = document.createElement("span");
        glyph.className = "emoji-map-glyph";
        glyph.textContent = item.symbol;
        button.appendChild(glyph);
      }

      button.addEventListener("click", (ev) => {
        if (destroyed || busy || Date.now() < suppressClickUntil) return;
        ev.preventDefault();
        const hit = { item, key, button };
        if (opts.moveMode) opts.onFirst(hit, null);
        else opts.onPick(hit);
      });

      buttons.set(key, button);
      picker.appendChild(button);
    });

    function buttonFor(key) {
      return buttons.get(key) || null;
    }

    function spinTransition() {
      viewport.classList.remove("is-switching");
      void viewport.offsetWidth;
      viewport.classList.add("is-switching");
      clearTimeout(switchTimer);
      switchTimer = window.setTimeout(() => {
        if (!destroyed) viewport.classList.remove("is-switching");
      }, 560);
    }

    function localY(clientY) {
      const rect = viewport.getBoundingClientRect();
      return clientY - rect.top;
    }

    function isRoomSwipe(ev) {
      if (!pointer) return false;
      const rect = viewport.getBoundingClientRect();
      const dx = ev.clientX - pointer.startX;
      const dy = ev.clientY - pointer.startY;
      const midY = rect.height / 2;
      const startY = localY(pointer.startY);
      const endY = localY(ev.clientY);
      return (
        Math.abs(dx) >= rect.width * ROOM_SWIPE_MIN_RATIO &&
        Math.abs(dy) <= rect.height * 0.23 &&
        Math.abs(startY - midY) <= rect.height * ROOM_SWIPE_CENTER_RATIO &&
        Math.abs(endY - midY) <= rect.height * ROOM_SWIPE_CENTER_RATIO
      );
    }

    function onPointerDown(ev) {
      if (destroyed || busy) return;
      const hitButton = ev.target && ev.target.closest ? ev.target.closest(".emoji-map-pick") : null;
      pointer = {
        id: ev.pointerId,
        startX: ev.clientX,
        startY: ev.clientY,
        lastX: ev.clientX,
        lastY: ev.clientY,
        hitButton,
      };
      if (!hitButton) {
        try {
          viewport.setPointerCapture(ev.pointerId);
        } catch {}
      }
    }

    function onPointerMove(ev) {
      if (!pointer) return;
      const dx = ev.clientX - pointer.startX;
      const dy = ev.clientY - pointer.startY;
      pointer.lastX = ev.clientX;
      pointer.lastY = ev.clientY;
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.4) ev.preventDefault();
    }

    function onPointerUp(ev) {
      if (!pointer) return;
      const swiped = isRoomSwipe(ev);
      pointer = null;
      if (!swiped) return;
      ev.preventDefault();
      suppressClickUntil = Date.now() + 360;
      spinTransition();
      if (typeof opts.onRoomSwipe === "function") window.setTimeout(opts.onRoomSwipe, 120);
    }

    function onPointerCancel() {
      pointer = null;
    }

    viewport.addEventListener("pointerdown", onPointerDown);
    viewport.addEventListener("pointermove", onPointerMove, { passive: false });
    viewport.addEventListener("pointerup", onPointerUp);
    viewport.addEventListener("pointercancel", onPointerCancel);

    return {
      setSelected(key) {
        if (selectedKey && selectedKey !== key) {
          const prev = buttonFor(selectedKey);
          if (prev) prev.classList.remove("sel");
        }
        selectedKey = key;
        const button = buttonFor(key);
        if (button) button.classList.add("sel");
      },
      flashMiss(key) {
        const button = buttonFor(key);
        if (!button) return;
        button.classList.add("miss");
        clearTimeout(missTimer);
        missTimer = window.setTimeout(() => {
          if (!destroyed) button.classList.remove("miss");
        }, 430);
      },
      spinTransition,
      destroy() {
        destroyed = true;
        clearTimeout(missTimer);
        clearTimeout(switchTimer);
        viewport.removeEventListener("pointerdown", onPointerDown);
        viewport.removeEventListener("pointermove", onPointerMove);
        viewport.removeEventListener("pointerup", onPointerUp);
        viewport.removeEventListener("pointercancel", onPointerCancel);
        buttons.forEach((button) => button.classList.remove("sel", "miss"));
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
      avatar.className = `nearby-avatar nearby-avatar-${kind === "phone" ? "phone" : "computer"}`;
      avatar.setAttribute("aria-hidden", "true");

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

  function normalizeRoomName(raw) {
    return String(raw || "")
      .toLowerCase()
      .normalize("NFKC")
      .replace(/[^a-z0-9._ -]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function showNameRoomModal() {
    if (!nameModal || busy || !done || activeGuide) return;
    if (nameStatus) nameStatus.textContent = "use a non-obvious name";
    nameModal.hidden = false;
    nameModal.classList.add("show");
    requestAnimationFrame(() => {
      if (nameInput) {
        nameInput.focus({ preventScroll: true });
        nameInput.select();
      }
    });
  }

  function hideNameRoomModal() {
    if (!nameModal) return;
    nameModal.classList.remove("show");
    nameModal.hidden = true;
  }

  function submitNameRoom(intent) {
    if (busy || !done || !nameInput) return;
    const name = normalizeRoomName(nameInput.value);
    if (name.length < 4 || name.length > 40 || new Set(name.replace(/[^a-z0-9]/g, "")).size < 2) {
      if (nameStatus) nameStatus.textContent = "4-40 chars, avoid obvious names";
      nameInput.focus();
      return;
    }
    busy = true;
    hideNameRoomModal();
    stopNearby(true);
    const cb = done;
    done = null;
    if (cb) cb({ named: true, name, intent }, `${intent}: ${name}`, { named: true, intent });
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
    fillSequence(seqEl, activeGuide.glyphs, 0, activeGuide.assets);
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

  function fillSequence(el, items, activeIndex, assets) {
    el.textContent = "";
    items.forEach((glyph, index) => {
      const item = document.createElement("span");
      item.className = "nearby-seq-item";
      if (index < activeIndex) item.classList.add("done");
      if (index === activeIndex) item.classList.add("active");
      const asset = Array.isArray(assets) ? assets[index] : "";
      const step = document.createElement("span");
      step.className = "nearby-seq-step";
      step.textContent = String(index + 1) + ".";
      item.appendChild(step);
      if (asset) {
        const img = document.createElement("img");
        img.className = "nearby-seq-emoji";
        img.src = asset;
        img.alt = glyph;
        img.loading = "lazy";
        img.decoding = "async";
        item.appendChild(img);
      } else {
        const fallback = document.createElement("span");
        fallback.className = "nearby-seq-glyph";
        fallback.textContent = glyph;
        item.appendChild(fallback);
      }
      el.appendChild(item);
    });
  }

  function renderGuideSequence() {
    if (!activeGuide || !nearbyInvite) return;
    const seqEl = nearbyInvite.querySelector(".nearby-seq");
    if (seqEl) fillSequence(seqEl, activeGuide.glyphs, guideIndex(), activeGuide.assets);
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
      value.glyphs.length === 3 &&
      (value.assets === undefined || (Array.isArray(value.assets) && value.assets.length === 3))
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
      assets: [firstEmoji.asset, secondEmoji.asset, thirdEmoji.asset],
    };
  }

  async function renderPalette() {
    const run = ++seq;
    first = null;
    ids = [];
    glyphs = [];
    pickedAssets = [];
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
        asset: e.asset,
        tapPos: optionIndex + 1,
        pos: cellIndex + 1,
        slot: cellIndex,
      };
    });
    renderEmojiGlobe(items, 0, true);
    revealGrid(true, 0);
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

  function commitFirst(id, pos, glyph, asset, btn) {
    if (activeGuide && (id !== activeGuide.first.id || pos !== activeGuide.first.pos)) {
      flashWrong(btn, `kliknij 1. ${activeGuide.glyphs[0]}`);
      return;
    }
    first = { id, pos };
    glyphs = [glyph];
    pickedAssets = [asset || ""];
    ids = [];
    busy = true;
    if (activeGlobe && btn && Number.isInteger(btn.globeKey)) activeGlobe.setSelected(btn.globeKey);
    if (activeGlobe && typeof activeGlobe.spinTransition === "function") activeGlobe.spinTransition();
    renderCrumb();
    renderGuideSequence();
    setTimeout(() => {
      busy = false;
      step();
    }, LEVEL_TRANSITION_DELAY_MS);
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
        asset: e.asset,
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
    if (activeGlobe && typeof activeGlobe.spinTransition === "function") activeGlobe.spinTransition();
    if (btn && btn.classList) btn.classList.add("sel");
    ids.push(e.id);
    glyphs.push(e.symbol);
    pickedAssets.push(e.asset || "");
    renderCrumb();
    renderGuideSequence();
    setTimeout(() => {
      busy = false;
      step();
    }, LEVEL_TRANSITION_DELAY_MS);
  }

  function back() {
    if (busy) return;
    if (ids.length > 0) {
      ids.pop();
      glyphs.pop();
      pickedAssets.pop();
      step();
    } else if (first) {
      renderPalette();
    }
  }

  function reset(notifyNearby) {
    seq++;
    first = null;
    ids = [];
    glyphs = [];
    pickedAssets = [];
    bucket = null;
    done = null;
    busy = false;
    activeGuide = null;
    activeInviteId = "";
    nearbyDrafts.clear();
    hideNameRoomModal();
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
  if (nameCreate) nameCreate.addEventListener("click", () => submitNameRoom("create"));
  if (nameJoin) nameJoin.addEventListener("click", () => submitNameRoom("join"));
  if (nameClose) nameClose.addEventListener("click", hideNameRoomModal);
  if (nameModal) {
    nameModal.addEventListener("click", (ev) => {
      if (ev.target === nameModal) hideNameRoomModal();
    });
  }
  if (nameInput) {
    nameInput.addEventListener("input", () => {
      const value = normalizeRoomName(nameInput.value);
      if (nameStatus) nameStatus.textContent = value && value !== nameInput.value ? "unsupported chars will be ignored" : "use a non-obvious name";
    });
    nameInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        submitNameRoom("join");
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        hideNameRoomModal();
      }
    });
  }
  window.addEventListener("pagehide", () => stopNearby(true));
  window.__P = { begin, reset };
})();
