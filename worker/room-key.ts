// Opaque room-token sealing. The browser receives only this bearer token; the
// room key is opened server-side and passed to the Durable Object via header.

import { sha256Bytes } from "./hash";

const enc = new TextEncoder();
const dec = new TextDecoder();
const ROOM_KEY_RE = /^[0-9a-f]{64}$/;
const TOKEN_TTL_MS = 5 * 60_000;
let cachedPepper = "";
let cachedKey: Promise<CryptoKey> | null = null;

async function sealingKey(pepper: string): Promise<CryptoKey> {
  if (!cachedKey || cachedPepper !== pepper) {
    cachedPepper = pepper;
    cachedKey = sha256Bytes("token-seal:" + pepper).then((raw) =>
      crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
    );
  }
  return cachedKey;
}

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sealRoomKey(roomKey: string, pepper: string): Promise<string> {
  if (!ROOM_KEY_RE.test(roomKey)) throw new Error("bad room key");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = `${Date.now() + TOKEN_TTL_MS}|${roomKey}`;
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sealingKey(pepper), enc.encode(payload)));
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return b64urlEncode(packed);
}

export async function openRoomKeyToken(token: string, pepper: string | undefined): Promise<string | null> {
  if (!token || !pepper) return null;
  try {
    const packed = b64urlDecode(token);
    if (packed.length < 13) return null;
    const iv = packed.slice(0, 12);
    const ct = packed.slice(12);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await sealingKey(pepper), ct);
    const text = dec.decode(pt);
    const sep = text.indexOf("|");
    if (sep < 0) return null;
    const exp = Number(text.slice(0, sep));
    if (!Number.isFinite(exp) || Date.now() > exp) return null;
    const key = text.slice(sep + 1);
    return ROOM_KEY_RE.test(key) ? key : null;
  } catch {
    return null;
  }
}
