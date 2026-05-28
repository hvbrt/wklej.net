// Builds the local animated emoji manifest from Google's official Noto Emoji
// Animation API. Runtime never calls this API.
//
// We keep pairing-safe symbols only: no ZWJ sequences, no skin-tone variants,
// no flags, and no visually duplicated symbols. Existing atlas order is kept
// first so already converted local WebP assets stay valid; new safe symbols are
// appended without duplicates.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const API_URL = "https://googlefonts.github.io/noto-emoji-animation/data/api.json";
const SOURCE = "scripts/animated-emoji.json";
const WORKER_ATLAS = "worker/atlas.ts";
const MIN_OPTIONS = 256;
const SKIN_TONES = new Set(["1f3fb", "1f3fc", "1f3fd", "1f3fe", "1f3ff"]);
// Keep only one representative from visually similar pairing groups.
// Globes: keep 🌍. Zodiac/constellation signs: keep ♈.
const EXCLUDED_CODES = new Set(["1f30e", "1f30f", "2649", "264a", "264b", "264c", "264d", "264e", "264f", "2650", "2651", "2652", "2653", "26ce"]);
const CATEGORY_ORDER = [
  "Animals and nature",
  "Food and drink",
  "Travel and places",
  "Activities and events",
  "Objects",
  "Symbols",
  "People",
  "Smileys and emotions",
];

function symbolFromCode(code) {
  return code
    .split("_")
    .map((part) => String.fromCodePoint(Number.parseInt(part, 16)))
    .join("");
}

function normalizeCode(code) {
  return code
    .toLowerCase()
    .split("_")
    .map((part) => part.padStart(4, "0"))
    .join("_");
}

function visualKey(symbol) {
  return symbol.normalize("NFKC").replace(/\ufe0f/g, "").replace(/[\u{1f3fb}-\u{1f3ff}]/gu, "");
}

function isRegionalIndicator(part) {
  const n = Number.parseInt(part, 16);
  return n >= 0x1f1e6 && n <= 0x1f1ff;
}

function safeEntry(icon) {
  const code = normalizeCode(String(icon.codepoint || ""));
  const parts = code.split("_");
  const category = String(icon.categories?.[0] || "Other");
  if (!/^[0-9a-f]+(?:_[0-9a-f]+)*$/.test(code)) return null;
  if (EXCLUDED_CODES.has(code)) return null;
  if (parts.includes("200d")) return null;
  if (parts.some((part) => SKIN_TONES.has(part))) return null;
  if (category === "Flags" || parts.some(isRegionalIndicator)) return null;

  const symbol = symbolFromCode(code);
  return {
    symbol,
    code,
    key: visualKey(symbol),
    category,
    popularity: Number(icon.popularity || 0),
  };
}

function readGeneratedAtlas() {
  if (!existsSync(WORKER_ATLAS)) return [];
  const raw = readFileSync(WORKER_ATLAS, "utf8");
  const start = raw.indexOf("export const ATLAS");
  if (start < 0) return [];
  const eq = raw.indexOf("=", start);
  const first = raw.indexOf("[", eq);
  const last = raw.lastIndexOf("]");
  if (eq < 0 || first < 0 || last < first) return [];
  try {
    const atlas = JSON.parse(raw.slice(first, last + 1));
    return atlas
      .map((entry) => {
        const asset = String(entry.asset || "");
        const match = asset.match(/\/emoji\/([0-9a-f_]+)\.webp$/i);
        return match ? { symbol: String(entry.symbol || ""), code: match[1].toLowerCase() } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readManifest() {
  if (!existsSync(SOURCE)) return [];
  try {
    const entries = JSON.parse(readFileSync(SOURCE, "utf8"));
    return Array.isArray(entries)
      ? entries.map((entry) => ({ symbol: String(entry.symbol || ""), code: String(entry.code || "").toLowerCase() }))
      : [];
  } catch {
    return [];
  }
}

const res = await fetch(API_URL);
if (!res.ok) throw new Error(`failed to fetch Noto animated emoji API: ${res.status}`);
const data = await res.json();
if (!Array.isArray(data.icons)) throw new Error("bad Noto animated emoji API payload");

const safe = [];
const byCode = new Map();
const bestByKey = new Map();
for (const icon of data.icons) {
  const entry = safeEntry(icon);
  if (!entry) continue;
  const existing = bestByKey.get(entry.key);
  if (existing && existing.popularity >= entry.popularity) continue;
  bestByKey.set(entry.key, entry);
}

for (const entry of bestByKey.values()) {
  safe.push(entry);
  byCode.set(entry.code, entry);
}

safe.sort((a, b) => b.popularity - a.popularity || a.code.localeCompare(b.code));

const byCategory = new Map();
for (const entry of safe) {
  if (!byCategory.has(entry.category)) byCategory.set(entry.category, []);
  byCategory.get(entry.category).push(entry);
}
for (const entries of byCategory.values()) entries.sort((a, b) => b.popularity - a.popularity || a.code.localeCompare(b.code));

const out = [];
const seenCodes = new Set();
const seenKeys = new Set();

function append(entry) {
  if (!entry || seenCodes.has(entry.code) || seenKeys.has(entry.key)) return false;
  seenCodes.add(entry.code);
  seenKeys.add(entry.key);
  out.push({ symbol: entry.symbol, code: entry.code });
  return true;
}

// Keep the currently generated Worker atlas first. That preserves IDs for the
// already deployed/converted set; the rest is appended below.
for (const previous of [...readGeneratedAtlas(), ...readManifest()]) {
  const entry = byCode.get(previous.code);
  append(entry);
}

const categories = [
  ...CATEGORY_ORDER,
  ...[...byCategory.keys()].filter((category) => !CATEGORY_ORDER.includes(category)).sort(),
];
let appended = true;
while (appended) {
  appended = false;
  for (const category of categories) {
    const entries = byCategory.get(category) || [];
    while (entries.length && (seenCodes.has(entries[0].code) || seenKeys.has(entries[0].key))) entries.shift();
    if (entries.length) appended = append(entries.shift()) || appended;
  }
}

if (out.length < MIN_OPTIONS) throw new Error(`expected at least ${MIN_OPTIONS} animated emoji, got ${out.length}`);

writeFileSync(SOURCE, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${SOURCE}: ${out.length} animated emoji`);
const counts = new Map();
for (const entry of out) {
  const category = byCode.get(entry.code)?.category || "Other";
  counts.set(category, (counts.get(category) || 0) + 1);
}
for (const [category, count] of [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
  console.log(`${category}: ${count}`);
}
