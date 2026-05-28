// Builds browser-visible assets from client/ into public/.
// Readable sources stay outside the served asset directory; public/ receives
// only minified, content-hashed JS/CSS plus the generated index.html.

import { transform } from "esbuild";
import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";

const PUB = "public";
const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 10);
const fontFiles = {
  "{{FONT_INTER_LATIN}}": "client/fonts/inter-latin.woff2",
  "{{FONT_INTER_LATIN_EXT}}": "client/fonts/inter-latin-ext.woff2",
  "{{FONT_SORA_LATIN}}": "client/fonts/sora-latin.woff2",
  "{{FONT_SORA_LATIN_EXT}}": "client/fonts/sora-latin-ext.woff2",
};
const staticAssets = {
  "{{WORLD_STRIP}}": "client/world-strip.webp",
};

if (!existsSync(PUB)) mkdirSync(PUB);

// Clean generated/static public surface from older builds (keep no readable JS/CSS
// names and do not expose the emoji atlas as a downloadable asset).
for (const f of readdirSync(PUB)) {
  if (/\.(js|css|html|woff2|webp)$/.test(f) || f === "emoji-atlas.json") unlinkSync(`${PUB}/${f}`);
}

// 1) Fonts — copy self-hosted WOFF2 files with content hashes.
let cssSrc = readFileSync("client/styles.css", "utf8");
const fontNames = [];
for (const [placeholder, src] of Object.entries(fontFiles)) {
  const font = readFileSync(src);
  const name = `${hash(font)}.woff2`;
  writeFileSync(`${PUB}/${name}`, font);
  cssSrc = cssSrc.replaceAll(placeholder, "/" + name);
  fontNames.push(name);
}

// Static UI images — content-hashed so long cache lifetimes stay safe.
const assetNames = [];
for (const [placeholder, src] of Object.entries(staticAssets)) {
  const asset = readFileSync(src);
  const ext = src.slice(src.lastIndexOf("."));
  const name = `${hash(asset)}${ext}`;
  writeFileSync(`${PUB}/${name}`, asset);
  cssSrc = cssSrc.replaceAll(placeholder, "/" + name);
  assetNames.push(name);
}

// 2) CSS — minify.
const cssMin = (await transform(cssSrc, { loader: "css", minify: true })).code;
const cssName = `${hash(cssMin)}.css`;
writeFileSync(`${PUB}/${cssName}`, cssMin);

// 3) App JS — concat (load order: pairing, transport, main) then minify+mangle.
const appSrc = ["client/pair.js", "client/rtc.js", "client/main.js"].map((f) => readFileSync(f, "utf8")).join("\n;\n");
const appMin = (await transform(appSrc, { loader: "js", minify: true, target: "es2019", legalComments: "none" })).code;
const appName = `${hash(appMin)}.js`;
writeFileSync(`${PUB}/${appName}`, appMin);

// 4) HTML — inject hashed names + light minify (strip comments, de-indent).
let html = readFileSync("client/index.html", "utf8")
  .replace("{{CSS}}", "/" + cssName)
  .replace("{{APP}}", "/" + appName)
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/^\s+/gm, "")
  .replace(/\n{2,}/g, "\n")
  .trim();
writeFileSync(`${PUB}/index.html`, html);

console.log(`built: ${cssName}, ${appName}, ${fontNames.join(", ")}, ${assetNames.join(", ")}, index.html`);
