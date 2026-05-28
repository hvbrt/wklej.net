# Reproducible client build

The browser client is built from readable sources in `client/` into content-hashed files in `public/`.

## Verify locally

```bash
npm ci
npm run verify:client
```

`verify:client` runs `build:public` and prints deterministic SHA-256 checksums for:

- source files used by the browser client,
- `package-lock.json`,
- generated public assets served to browsers.

A reviewer can compare the generated `public/index.html` asset names and the checksum report against the deployed HTML from `https://wklej.net/`.

The build also writes `public/build-manifest.json` with:

- the short browser build fingerprint shown in the UI,
- content hashes and SRI values for generated assets,
- optional signature metadata when a signing key is provided through the environment.

To produce a signed manifest locally, provide an ECDSA P-256 key through one of:

```bash
BUILD_MANIFEST_ECDSA_P256_PRIVATE_KEY_PEM='-----BEGIN PRIVATE KEY-----...'
BUILD_MANIFEST_ECDSA_P256_PRIVATE_KEY_PEM_B64URL='<base64url encoded PEM>'
```

Ed25519 is also supported when browser compatibility is acceptable:

```bash
BUILD_MANIFEST_ED25519_PRIVATE_KEY_PEM='-----BEGIN PRIVATE KEY-----...'
BUILD_MANIFEST_ED25519_PRIVATE_KEY_PEM_B64URL='<base64url encoded PEM>'
```

Do not commit the private signing key.

## CI

`.github/workflows/reproducible-client.yml` runs:

```bash
npm ci
npm run typecheck
npm run verify:client
```

This does not publish secrets and does not deploy. It only proves that the committed client sources build into deterministic hashed browser assets.

## Publication note

The repository can be made public with this build workflow. Choose and commit a license before treating the project as open source in the legal sense.
