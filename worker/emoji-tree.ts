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

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function options(bucket: number, prefix: string, pepper: string): Promise<EmojiDTO[]> {
  const ranked = await Promise.all(
    ATLAS.map(async (item) => ({
      item,
      score: hex(await hmacBytes(pepper, `tree:v5:${bucket}:${prefix}:${item.id}`)),
    })),
  );
  ranked.sort((a, b) => a.score.localeCompare(b.score));

  const out: EmojiDTO[] = [];
  const seen = new Set<string>();
  for (const { item } of ranked) {
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
