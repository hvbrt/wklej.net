const CHANNEL = "wklej-shortcut-payload-v1";
const PAYLOAD_TTL_MS = 60000;
const RETRY_EVERY_MS = 900;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.mode !== "navigate" || url.origin !== self.location.origin || url.pathname !== "/shortcut-attach") return;
  event.respondWith(handleShortcutAttach(event, url));
});

async function handleShortcutAttach(event, url) {
  const envelope = buildEnvelope(url);
  if (envelope) event.waitUntil(deliverUntilAccepted(envelope));
  // 204 keeps the current document visible for navigation requests, so the
  // Shortcut handoff does not replace the live WebRTC session tab.
  return new Response(null, {
    status: 204,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function deliverUntilAccepted(envelope) {
  const deadline = Math.min(envelope.expiresAt || Date.now(), Date.now() + PAYLOAD_TTL_MS);
  while (Date.now() < deadline) {
    if (await notifyClients(envelope)) return;
    await delay(RETRY_EVERY_MS);
  }
}

function buildEnvelope(url) {
  const file = url.searchParams.get("file") || url.searchParams.get("fileB64") || url.searchParams.get("b64") || url.searchParams.get("data") || "";
  const text = url.searchParams.get("text") || url.searchParams.get("message") || url.searchParams.get("body") || "";
  const payload = file
    ? {
        kind: "file",
        name: cleanText(url.searchParams.get("filename") || url.searchParams.get("fileName") || url.searchParams.get("title") || "wklej-shortcut.bin", 96),
        mime: cleanMime(url.searchParams.get("mime") || url.searchParams.get("type") || "application/octet-stream"),
        file,
      }
    : text
      ? { kind: "text", text: cleanText(text, 8000) }
      : null;
  if (!payload) return null;
  return {
    type: "wklej-shortcut-payload",
    id: randomId(),
    expiresAt: Date.now() + PAYLOAD_TTL_MS,
    room: cleanText(url.searchParams.get("room") || "", 80),
    targetRole: cleanRole(url.searchParams.get("targetRole") || url.searchParams.get("role") || ""),
    payload,
  };
}

async function notifyClients(envelope) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  let accepted = false;
  await Promise.all(
    clients.map(async (client) => {
      try {
        const channel = new MessageChannel();
        client.postMessage(envelope, [channel.port2]);
        const ok = await Promise.race([
          new Promise((resolve) => {
            channel.port1.onmessage = (ev) => resolve(!!(ev.data && ev.data.ok));
          }),
          delay(650).then(() => false),
        ]);
        accepted = accepted || ok;
      } catch {}
    }),
  );
  try {
    const broadcast = new BroadcastChannel(CHANNEL);
    broadcast.postMessage(envelope);
    broadcast.close();
  } catch {}
  return accepted;
}

function cleanText(value, max) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\0\r\n]+/g, " ")
    .trim()
    .slice(0, max);
}

function cleanMime(value) {
  const mime = cleanText(value, 80).toLowerCase();
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(mime) ? mime : "application/octet-stream";
}

function cleanRole(value) {
  const role = cleanText(value, 12).toLowerCase();
  return role === "seed" || role === "peer" ? role : "";
}

function randomId() {
  if (self.crypto && crypto.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
