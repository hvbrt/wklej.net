// Builds browser-visible assets from client/ into public/.
// Readable sources stay outside the served asset directory; public/ receives
// only minified, content-hashed JS/CSS plus the generated index.html.

import { transform } from "esbuild";
import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";

const PUB = "public";
const digest = (alg, input, enc = "hex") => createHash(alg).update(input).digest(enc);
const sha256 = (input) => digest("sha256", input);
const hash = (input) => sha256(input).slice(0, 10);
const integrity = (input) => `sha384-${digest("sha384", input, "base64")}`;
const b64urlToUtf8 = (value) => Buffer.from(value, "base64url").toString("utf8");
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
  if (/\.(js|css|html|woff2|webp)$/.test(f) || f === "emoji-atlas.json" || f === "build-manifest.json") unlinkSync(`${PUB}/${f}`);
}

// 1) Fonts — copy self-hosted WOFF2 files with content hashes.
let cssSrc = readFileSync("client/styles.css", "utf8");
const assets = {};
for (const [placeholder, src] of Object.entries(fontFiles)) {
  const font = readFileSync(src);
  const name = `${hash(font)}.woff2`;
  writeFileSync(`${PUB}/${name}`, font);
  cssSrc = cssSrc.replaceAll(placeholder, "/" + name);
  assets[name] = assetEntry(name, font);
}

// Static UI images — content-hashed so long cache lifetimes stay safe.
for (const [placeholder, src] of Object.entries(staticAssets)) {
  const asset = readFileSync(src);
  const ext = src.slice(src.lastIndexOf("."));
  const name = `${hash(asset)}${ext}`;
  writeFileSync(`${PUB}/${name}`, asset);
  cssSrc = cssSrc.replaceAll(placeholder, "/" + name);
  assets[name] = assetEntry(name, asset);
}

// 2) CSS — minify.
const cssMin = (await transform(cssSrc, { loader: "css", minify: true })).code;
const cssName = `${hash(cssMin)}.css`;
writeFileSync(`${PUB}/${cssName}`, cssMin);
assets[cssName] = assetEntry(cssName, cssMin);

// 3) App JS — concat (load order: pairing, transport, main) then minify+mangle.
const appSrc = ["client/pair.js", "client/rtc.js", "client/main.js"].map((f) => readFileSync(f, "utf8")).join("\n;\n");
const appMin = (await transform(appSrc, { loader: "js", minify: true, target: "es2019", legalComments: "none" })).code;
const appName = `${hash(appMin)}.js`;
writeFileSync(`${PUB}/${appName}`, appMin);
assets[appName] = assetEntry(appName, appMin);

// Fixed URL service worker used only for iOS Shortcut handoff interception.
const swSrc = readFileSync("client/shortcut-sw.js", "utf8");
const swMin = (await transform(swSrc, { loader: "js", minify: true, target: "es2019", legalComments: "none" })).code;
writeFileSync(`${PUB}/shortcut-sw.js`, swMin);
assets["shortcut-sw.js"] = assetEntry("shortcut-sw.js", swMin);

const buildHash = sha256(
  stableStringify({
    app: assets[appName],
    css: assets[cssName],
    static: Object.fromEntries(Object.entries(assets).sort(([a], [b]) => a.localeCompare(b))),
  }),
);
const buildFingerprint = `${buildHash.slice(0, 4)}-${buildHash.slice(4, 8)}`.toUpperCase();
const signing = signingMaterial();

// 4) HTML — inject hashed names + light minify (strip comments, de-indent).
let html = readFileSync("client/index.html", "utf8")
  .replace("{{CSS}}", "/" + cssName)
  .replace("{{CSS_INTEGRITY}}", assets[cssName].integrity)
  .replace("{{APP}}", "/" + appName)
  .replace("{{APP_INTEGRITY}}", assets[appName].integrity)
  .replaceAll("{{BUILD_FINGERPRINT}}", buildFingerprint)
  .replaceAll("{{BUILD_HASH}}", buildHash)
  .replaceAll("{{BUILD_SIGNED}}", signing.signed ? "true" : "false")
  .replaceAll("{{BUILD_PUBLIC_KEY}}", signing.publicKey || "")
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/^\s+/gm, "")
  .replace(/\n{2,}/g, "\n")
  .trim();
writeFileSync(`${PUB}/index.html`, html);
assets["index.html"] = assetEntry("index.html", html);

const manifestPayload = {
  version: 1,
  build: {
    fingerprint: buildFingerprint,
    sha256: buildHash,
    generatedAt: buildTimestamp(),
  },
  entrypoints: {
    html: "/",
    css: "/" + cssName,
    app: "/" + appName,
  },
  assets,
};
const signatureValue = signing.privateKey ? signPayload(manifestPayload, signing.privateKey) : "";
const manifest = {
  ...manifestPayload,
  signature: signatureValue
    ? { alg: signing.alg, key: signing.publicKey, value: signatureValue }
    : { alg: "none", signed: false },
};
writeFileSync(`${PUB}/build-manifest.json`, stableStringify(manifest) + "\n");

console.log(`built: ${cssName}, ${appName}, ${Object.keys(assets).filter((name) => name !== cssName && name !== appName && name !== "index.html").join(", ")}, index.html, build ${buildFingerprint}`);

function assetEntry(name, content) {
  return {
    path: "/" + name,
    bytes: Buffer.byteLength(content),
    sha256: sha256(content),
    integrity: integrity(content),
  };
}

function buildTimestamp() {
  const epoch = Number(process.env.SOURCE_DATE_EPOCH || 0);
  return new Date(Number.isFinite(epoch) && epoch > 0 ? epoch * 1000 : 0).toISOString();
}

function signingMaterial() {
  const privateKeyRaw =
    process.env.BUILD_MANIFEST_PRIVATE_KEY_PEM ||
    process.env.BUILD_MANIFEST_PRIVATE_KEY_PEM_B64URL ||
    process.env.BUILD_MANIFEST_ECDSA_P256_PRIVATE_KEY_PEM ||
    process.env.BUILD_MANIFEST_ECDSA_P256_PRIVATE_KEY_PEM_B64URL ||
    process.env.BUILD_MANIFEST_ED25519_PRIVATE_KEY_PEM ||
    process.env.BUILD_MANIFEST_ED25519_PRIVATE_KEY_PEM_B64URL;
  if (!privateKeyRaw) return { signed: false, publicKey: "", privateKey: null };
  const privateKeyPem = privateKeyRaw.includes("BEGIN") ? privateKeyRaw : b64urlToUtf8(privateKeyRaw);
  const privateKey = createPrivateKey(privateKeyPem);
  const alg = signingAlg(privateKey);
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64url");
  return { signed: true, publicKey, privateKey, alg };
}

function signPayload(payload, privateKey) {
  const data = Buffer.from(stableStringify(payload));
  const alg = signingAlg(privateKey);
  if (alg === "Ed25519") return sign(null, data, privateKey).toString("base64url");
  return sign("sha256", data, { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
}

function signingAlg(privateKey) {
  if (privateKey.asymmetricKeyType === "ed25519") return "Ed25519";
  if (privateKey.asymmetricKeyType === "ec" && privateKey.asymmetricKeyDetails?.namedCurve === "prime256v1") {
    return "ECDSA-P256-SHA256";
  }
  throw new Error(`Unsupported build manifest signing key: ${privateKey.asymmetricKeyType || "unknown"}`);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
