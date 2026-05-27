// Builds the curated 256-symbol manifest from Google's official Noto Emoji
// Animation API. We keep only single-codepoint/variation-selector-safe emoji:
// no ZWJ, no skin tones, no flags. Runtime never calls this API.

import { writeFileSync } from "node:fs";

const API_URL = "https://googlefonts.github.io/noto-emoji-animation/data/api.json";
const TARGET = 256;
const SKIN_TONES = new Set(["1f3fb", "1f3fc", "1f3fd", "1f3fe", "1f3ff"]);

function symbolFromCode(code) {
  return code
    .split("_")
    .map((part) => String.fromCodePoint(Number.parseInt(part, 16)))
    .join("");
}

function visualKey(symbol) {
  return symbol.normalize("NFKC").replace(/\ufe0f/g, "").replace(/[\u{1f3fb}-\u{1f3ff}]/gu, "");
}

const res = await fetch(API_URL);
if (!res.ok) throw new Error(`failed to fetch Noto animated emoji API: ${res.status}`);
const data = await res.json();
if (!Array.isArray(data.icons)) throw new Error("bad Noto animated emoji API payload");

const seen = new Set();
const out = [];
for (const icon of data.icons.slice().sort((a, b) => Number(b.popularity || 0) - Number(a.popularity || 0))) {
  const code = String(icon.codepoint || "").toLowerCase();
  const parts = code.split("_");
  if (!/^[0-9a-f]+(?:_[0-9a-f]+)*$/.test(code)) continue;
  if (parts.includes("200d")) continue;
  if (parts.some((part) => SKIN_TONES.has(part))) continue;
  if (parts.every((part) => /^1f1[ef][0-9a-f]$/.test(part))) continue;

  const symbol = symbolFromCode(code);
  const key = visualKey(symbol);
  if (seen.has(key)) continue;
  seen.add(key);
  out.push({ symbol, code });
  if (out.length === TARGET) break;
}

if (out.length !== TARGET) throw new Error(`expected ${TARGET} animated emoji, got ${out.length}`);
writeFileSync("scripts/animated-emoji.json", JSON.stringify(out, null, 2) + "\n");
console.log(`wrote scripts/animated-emoji.json: ${out.length} animated emoji`);
