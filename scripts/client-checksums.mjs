// Print deterministic checksums for the browser client surface.
// Use after `npm run build:public` to compare a local build with published assets.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const sourceFiles = [
  "client/index.html",
  "client/styles.css",
  "client/pair.js",
  "client/rtc.js",
  "client/main.js",
  "scripts/build-public.mjs",
  "package-lock.json",
];

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...walk(path));
    else out.push(path.replace(/\\/g, "/"));
  }
  return out;
}

function entry(file) {
  return { file, bytes: statSync(file).size, sha256: sha256(file) };
}

const report = {
  generatedAt: new Date(0).toISOString(),
  nodeMajor: Number(process.versions.node.split(".")[0]),
  source: sourceFiles.filter(existsSync).map(entry),
  public: walk("public").map(entry),
};

process.stdout.write(JSON.stringify(report, null, 2) + "\n");
