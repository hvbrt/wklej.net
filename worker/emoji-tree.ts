// Bucket-rotating emoji tree. First move is spatial: emoji id + drop position.

import { ATLAS } from "./atlas";
import type { EmojiDTO, FirstMove } from "./room-state";

export const TREE_DEPTH = 3;
export const TREE_OPTIONS = 12;
export const POS_COUNT = 12;
const SKIN_TONE_RE = /[\u{1f3fb}-\u{1f3ff}]/gu;
const VARIATION_SELECTOR_RE = /\ufe0f/g;
const enc = new TextEncoder();
let cachedHmacPepper = "";
let cachedHmacKey: Promise<CryptoKey> | null = null;

export function isValidPos(p: unknown): p is number {
  return Number.isInteger(p) && (p as number) >= 1 && (p as number) <= POS_COUNT;
}

function prefixKey(first: FirstMove | null, rest: number[]): string {
  if (!first) return "";
  return `${first.id}@${first.pos}` + (rest.length ? "|" + rest.join(",") : "");
}

function visualKey(symbol: string): string {
  return symbol.normalize("NFKC").replace(VARIATION_SELECTOR_RE, "").replace(SKIN_TONE_RE, "");
}

function hmacKey(pepper: string): Promise<CryptoKey> {
  if (!cachedHmacKey || cachedHmacPepper !== pepper) {
    cachedHmacPepper = pepper;
    cachedHmacKey = crypto.subtle.importKey(
      "raw",
      enc.encode(pepper),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }
  return cachedHmacKey;
}

async function hmacBytes(pepper: string, msg: string): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(pepper), enc.encode(msg));
  return new Uint8Array(sig);
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function options(bucket: number, prefix: string, pepper: string): Promise<EmojiDTO[]> {
  const bytes = await hmacBytes(pepper, `tree:v4:${bucket}:${prefix}`);
  const seed = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
  const rng = mulberry32(seed);
  const idx = ATLAS.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  const out: EmojiDTO[] = [];
  const seen = new Set<string>();
  for (const i of idx) {
    const item = ATLAS[i]!;
    const key = visualKey(item.symbol);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: item.id, symbol: item.symbol, asset: item.asset });
    if (out.length === TREE_OPTIONS) return out;
  }
  throw new Error("atlas does not contain enough unique visible emoji");
}

export function paletteOptions(bucket: number, pepper: string): Promise<EmojiDTO[]> {
  return options(bucket, "", pepper);
}

export function levelAfter(bucket: number, first: FirstMove, rest: number[], pepper: string): Promise<EmojiDTO[]> {
  return options(bucket, prefixKey(first, rest), pepper);
}

export async function isValidFirst(bucket: number, first: FirstMove, pepper: string): Promise<boolean> {
  if (!first || !isValidPos(first.pos) || !Number.isInteger(first.id)) return false;
  const pal = await paletteOptions(bucket, pepper);
  return pal.some((o) => o.id === first.id);
}

export async function isValidProgress(bucket: number, first: FirstMove | null, rest: number[], pepper: string): Promise<boolean> {
  if (first === null) return rest.length === 0;
  if (!(await isValidFirst(bucket, first, pepper))) return false;
  if (rest.length > TREE_DEPTH - 1) return false;
  for (let d = 0; d < rest.length; d++) {
    const opts = await levelAfter(bucket, first, rest.slice(0, d), pepper);
    if (!opts.some((o) => o.id === rest[d])) return false;
  }
  return true;
}

export function isValidSelection(bucket: number, first: FirstMove, rest: number[], pepper: string): Promise<boolean> {
  return rest.length === TREE_DEPTH - 1 ? isValidProgress(bucket, first, rest, pepper) : Promise.resolve(false);
}
