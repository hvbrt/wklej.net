// Downloads Google's Noto animated emoji WebP assets and transcodes them to
// compact local animated WebP files. Runtime uses only these self-hosted files.
// Tunables: ANIMATED_EMOJI_SIZE, ANIMATED_EMOJI_QUALITY, ANIMATED_EMOJI_MAX_FRAMES,
// ANIMATED_EMOJI_CONCURRENCY.

import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pipeline } from "node:stream/promises";

const SOURCE = "scripts/animated-emoji.json";
const OUT_DIR = "public/emoji";
const BASE = "https://fonts.gstatic.com/s/e/notoemoji/latest";
const TARGET_SIZE = Number(process.env.ANIMATED_EMOJI_SIZE || 112);
const QUALITY = Number(process.env.ANIMATED_EMOJI_QUALITY || 46);
const MAX_FRAMES = Number(process.env.ANIMATED_EMOJI_MAX_FRAMES || 12);
const CONCURRENCY = Number(process.env.ANIMATED_EMOJI_CONCURRENCY || 4);
const MIN_BYTES = 2048;

function requireTool(name) {
  try {
    execFileSync("/usr/bin/env", ["which", name], { stdio: "ignore" });
  } catch {
    throw new Error(`${name} is required to transcode animated emoji assets`);
  }
}

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: opts.stdio || "pipe" });
}

function parseInfo(raw) {
  const canvasMatch = raw.match(/Canvas size:\s+(\d+)\s+x\s+(\d+)/);
  if (!canvasMatch) throw new Error("could not read WebP canvas size");
  const frames = [];
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*(\d+):\s+(\d+)\s+(\d+)\s+\w+\s+(\d+)\s+(\d+)\s+(\d+)\s+(background|none)\s+(yes|no)\s+/);
    if (!match) continue;
    frames.push({
      index: Number(match[1]),
      width: Number(match[2]),
      height: Number(match[3]),
      x: Number(match[4]),
      y: Number(match[5]),
      duration: Number(match[6]),
      dispose: match[7] === "background" ? 1 : 0,
      blend: match[8] === "yes" ? "+b" : "-b",
    });
  }
  if (!frames.length) throw new Error("animated WebP contains no frames");
  return { canvasWidth: Number(canvasMatch[1]), canvasHeight: Number(canvasMatch[2]), frames };
}

function chooseFrames(frames) {
  const step = Math.max(1, Math.ceil(frames.length / MAX_FRAMES));
  const chosen = [];
  for (let i = 0; i < frames.length; i += step) {
    const source = frames[i];
    const duration = frames.slice(i, Math.min(frames.length, i + step)).reduce((sum, frame) => sum + frame.duration, 0);
    chosen.push({ ...source, duration });
  }
  return chosen;
}

function evenOffset(value) {
  return Math.max(0, Math.round(value / 2) * 2);
}

async function download(url, out) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${url}`);
  const type = res.headers.get("content-type") || "";
  if (!type.includes("image/webp")) throw new Error(`unexpected content-type for ${url}: ${type}`);
  await pipeline(res.body, createWriteStream(out));
}

async function transcodeAnimatedWebp(source, out) {
  const temp = await mkdtemp(join(tmpdir(), "wklej-emoji-"));
  try {
    const info = parseInfo(execFileSync("webpmux", ["-info", source], { encoding: "utf8" }));
    const frames = chooseFrames(info.frames);
    const scale = TARGET_SIZE / Math.max(info.canvasWidth, info.canvasHeight);
    const argsFile = join(temp, "webpmux-args.txt");
    let args = "";

    for (const frame of frames) {
      const rawFrame = join(temp, `frame-${frame.index}.webp`);
      const pngFrame = join(temp, `frame-${frame.index}.png`);
      const smallFrame = join(temp, `small-${frame.index}.webp`);
      const width = Math.max(1, Math.round(frame.width * scale));
      const height = Math.max(1, Math.round(frame.height * scale));
      const x = evenOffset(frame.x * scale);
      const y = evenOffset(frame.y * scale);

      run("webpmux", ["-get", "frame", String(frame.index), source, "-o", rawFrame]);
      run("dwebp", [rawFrame, "-o", pngFrame]);
      run("cwebp", ["-quiet", "-q", String(QUALITY), "-m", "3", "-mt", "-resize", String(width), String(height), pngFrame, "-o", smallFrame]);
      args += `-frame\n${smallFrame} +${frame.duration}+${x}+${y}+${frame.dispose}${frame.blend}\n`;
    }

    args += `-loop\n0\n-bgcolor\n0,0,0,0\n-o\n${out}\n`;
    writeFileSync(argsFile, args);
    run("webpmux", [argsFile]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function processEntry(entry) {
  const symbol = String(entry.symbol || "");
  const code = String(entry.code || "").toLowerCase();
  if (!/^[0-9a-f]+(?:_[0-9a-f]+)*$/.test(code)) throw new Error(`bad animated emoji code for ${symbol}: ${code}`);

  const file = `${OUT_DIR}/${code}.webp`;
  if (existsSync(file) && statSync(file).size >= MIN_BYTES) return { cached: true, size: statSync(file).size };

  const temp = await mkdtemp(join(tmpdir(), "wklej-emoji-src-"));
  const original = join(temp, `${code}-512.webp`);
  const compact = join(temp, `${code}-${TARGET_SIZE}.webp`);
  try {
    await download(`${BASE}/${code}/512.webp`, original);
    await transcodeAnimatedWebp(original, compact);
    const size = statSync(compact).size;
    if (size < MIN_BYTES) throw new Error(`compact asset is too small for ${symbol} ${code}: ${size}`);
    if (existsSync(file)) unlinkSync(file);
    await rename(compact, file);
    return { cached: false, size };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

requireTool("webpmux");
requireTool("dwebp");
requireTool("cwebp");

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
const entries = JSON.parse(readFileSync(SOURCE, "utf8"));
if (!Array.isArray(entries)) throw new Error(`${SOURCE} must contain an array`);

let cached = 0;
let converted = 0;
let totalBytes = 0;
let cursor = 0;

async function worker() {
  while (cursor < entries.length) {
    const index = cursor++;
    const result = await processEntry(entries[index]);
    totalBytes += result.size;
    if (result.cached) cached++;
    else converted++;
    if ((cached + converted) % 32 === 0 || cached + converted === entries.length) {
      console.log(`animated emoji: ${cached + converted}/${entries.length}`);
    }
  }
}

await Promise.all(Array.from({ length: Math.max(1, Math.min(CONCURRENCY, entries.length)) }, () => worker()));
console.log(
  `animated emoji assets: ${cached} cached, ${converted} converted, ${TARGET_SIZE}px/q${QUALITY}, max ${MAX_FRAMES} frames, ${(totalBytes / 1024 / 1024).toFixed(1)} MiB`,
);
