# Agent Guide (`backup-to-proton-drive`)

## 1. Project Overview

`backup-to-proton-drive` is a TypeScript/Node.js CLI and container service that performs one-way, SHA1-verified backup synchronization across multiple local-to-remote directory mappings (`L1 -> R1, L2 -> R2, ...`) using Proton's official [`@protontech/drive-sdk`](https://www.npmjs.com/package/@protontech/drive-sdk) and [`@protontech/crypto`](https://www.npmjs.com/package/@protontech/crypto).

For full user-facing specifications, CLI precedence, and operational caveats, see [`REQUIREMENTS.md`](./REQUIREMENTS.md).

---

## 2. Repository Map & Tooling Setup

| File / Directory | Purpose |
| :--- | :--- |
| [`src/index.ts`](./src/index.ts) | CLI entrypoint (`help`, `login`, `sync`, `status-server`, `report-failure`, `home-assistant-config`), `SIGINT`/`SIGTERM` `AbortController`, and crypto cleanup |
| [`src/types.ts`](./src/types.ts) | Core interfaces, configuration schemas, state types, run status types, and `ProtonDriveAdapter` contract |
| [`src/config.ts`](./src/config.ts) | Multi-mapping parser (`--map`, `SYNC_MAPPINGS`, YAML/JSON config, legacy flags/env, `*_FILE` secrets, status options) |
| [`src/concurrency.ts`](./src/concurrency.ts) | Fail-fast bounded-concurrency worker pool (`runWithConcurrency`) |
| [`src/format.ts`](./src/format.ts) | Bounds-safe binary byte formatting (`formatBytes`) and MIME lookup (`inferMediaType`) |
| [`src/ignore.ts`](./src/ignore.ts) | Zero-dependency glob exclude compiler and matcher (`compileExcludeMatcher`) |
| [`src/localScanner.ts`](./src/localScanner.ts) | Async directory walker with exclude pruning and constant-RAM streaming SHA1 hashing |
| [`src/diffEngine.ts`](./src/diffEngine.ts) | Pure deterministic planner: exact matches, 1-to-1 SHA1 move/rename matching, uploads, batched trash |
| [`src/remoteState.ts`](./src/remoteState.ts) | Persistent remote state (`STATE_FILE`) and incremental `iterateEvents` synchronization |
| [`src/runStatus.ts`](./src/runStatus.ts) | Atomic plaintext run telemetry (`status.json`), error sanitization, and staleness evaluation |
| [`src/statusServer.ts`](./src/statusServer.ts) | Built-in HTTP telemetry server (`status-server`) exposing `/status`, `/health`, and opt-in `POST /trigger` |
| [`src/homeAssistantConfig.ts`](./src/homeAssistantConfig.ts) | Pure Home Assistant YAML package generator (`home-assistant-config`) with prefix slug derivation |
| [`src/syncRunner.ts`](./src/syncRunner.ts) | Multi-mapping one-shot orchestrator executing plans (and `--dry-run`) via `ProtonDriveAdapter` |
| [`src/proton/totp.ts`](./src/proton/totp.ts) | Base32 decoder and RFC 6238 HMAC-SHA1 TOTP code generator |
| [`src/proton/sessionStore.ts`](./src/proton/sessionStore.ts) | Atomic `0600` persistence for Proton session tokens and salted key passphrases |
| [`src/storageEncryption.ts`](./src/storageEncryption.ts) | HKDF-SHA256 + AES-256-GCM at-rest encryption envelope for `session.json` and `state.json` |
| [`src/proton/auth.ts`](./src/proton/auth.ts) | `CryptoProxy` setup, SRP-6a + 2FA auth, interactive `login`, headless login, single-flight token refresh |
| [`src/proton/client.ts`](./src/proton/client.ts) | `ProtonDriveHTTPClient`, `ProtonDriveAccount`, `SRPModule`, and `SdkProtonDriveAdapter` |
| [`scripts/build.mjs`](./scripts/build.mjs) | `esbuild` bundler creating [`dist/index.js`](./dist/index.js) with `openpgp/lightweight` Node resolution |
| [`test/*.test.ts`](./test) | Automated unit, integration, and bundle smoke tests using `node:test` |
| [`Dockerfile`](./Dockerfile) | Multi-stage digest-pinned `node:26-slim` non-root container image (`--platform=$BUILDPLATFORM` builder) |
| [`.node-version`](./.node-version) | Pinned Node.js 26 toolchain version used by CI |
| [`compose.yaml`](./compose.yaml) / [`config.example.yaml`](./config.example.yaml) | Plug-and-play Docker/Podman Compose template (`backup` + `status` companion) and example YAML config |
| [`systemd/`](./systemd) | Sample `oneshot` service, daily timer, and on-demand `.path` trigger units for Compose + `systemd-creds` |
| [`examples/`](./examples) | Reference orchestration wrapper (`run-backup.sh`) and Home Assistant monitoring package (`home-assistant.yaml`) |
| [`.github/workflows/`](./.github/workflows) | SHA-pinned, `harden-runner`-protected CI, Release Please, and `verify`-gated GHCR publish + SLSA attestation workflows |
| [`.github/dependabot.yml`](./.github/dependabot.yml) | GitHub Dependabot configuration (weekly npm/Docker/Actions updates, exact npm pinning, Node 26 major-update ignore, 3-day npm cooldown) |
| [`release-please-config.json`](./release-please-config.json) / [`.release-please-manifest.json`](./.release-please-manifest.json) | Manifest-driven Release Please configuration and current version state |
| [`LICENSE`](./LICENSE) | Full GNU GPLv3 license text (`GPL-3.0-or-later`) |

### Build, Typecheck & Test Commands

- **Typecheck**: `npm run typecheck` (`tsc --noEmit`)
- **Build bundle**: `npm run build` (`node scripts/build.mjs` -> `dist/index.js`)
- **Run tests**: `npm test` (`node --test test/*.test.ts` — requires **Node >= 26** and built `dist/index.js` for `test/bundleSmoke.test.ts`)
- **Run locally**: `node dist/index.js --help`

---

## 3. Critical Codebase Nuances & Pitfalls for Agents

1. **Node 26 native TypeScript test compatibility**:
   - `npm test` runs `node --test test/*.test.ts` directly without a separate test bundler.
   - **Never** use TypeScript `enum` declarations or constructor parameter properties (`constructor(private foo: Bar)`) in `src/` or `test/`, and always use explicit `.ts` extensions on relative imports so Node 26 type stripping works cleanly.
   - Keep pure modules (`types.ts`, `concurrency.ts`, `config.ts`, `format.ts`, `ignore.ts`, `localScanner.ts`, `diffEngine.ts`, `remoteState.ts`, `runStatus.ts`, `statusServer.ts`, `homeAssistantConfig.ts`, `storageEncryption.ts`, `syncRunner.ts`, `proton/totp.ts`, `proton/sessionStore.ts`) free of runtime imports from `@protontech/drive-sdk` or `@protontech/crypto`, because `@protontech/drive-sdk/dist/*.js` contains extensionless ESM imports and relies on `esbuild`. Only `src/proton/auth.ts`, `src/proton/client.ts`, and `src/index.ts` import `@protontech/*` at runtime.

2. **`@protontech/crypto` raw `.ts` exports & `tsconfig.json`**:
   - `@protontech/crypto` exposes raw TypeScript sources in `package.json` `"exports"`, so `tsc --noEmit` typechecks `node_modules/@protontech/crypto/src/` even with `"skipLibCheck": true`.
   - Do **not** enable `noUncheckedIndexedAccess` or `exactOptionalPropertyTypes` in [`tsconfig.json`](./tsconfig.json) without resolving or excluding `@protontech/crypto/src/`, as upstream code in `@protontech/crypto` fails those two flags (`OpenPGPCryptoWithCryptoProxy` vs `OpenPGPCrypto` also fails `exactOptionalPropertyTypes`). Still write all project code defensively against undefined indices and optional fields.

3. **`esbuild` `"openpgp/lightweight"` resolution (`scripts/build.mjs`)**:
   - `@protontech/crypto/src/pmcrypto/openpgp.ts` imports `"openpgp/lightweight"`, whose `package.json` export only defines a `"browser"` condition.
   - [`scripts/build.mjs`](./scripts/build.mjs) maps `"openpgp/lightweight"` via `openpgpNodeResolvePlugin` to `node_modules/openpgp/dist/node/openpgp.mjs` and injects a CommonJS `createRequire` banner for transitive CJS modules. Keep both intact when changing build logic.

4. **Non-shortened variable names & documentation rules**:
   - Strictly avoid shortened variable/parameter names (write `relativePath`, `error`, `index`, `directoryPath`, `configuration`, `response`, etc. in full) and maintain thorough JSDoc comments across all files.

5. **`ProtonDriveHTTPClient` `FormData` + `401` single-flight refresh**:
   - `DriveAPIService` calls `httpClient.fetchJson` with **both** `request.json` and `request.body` (`FormData` for small file uploads). Never set `Content-Type` manually when `request.body` is `FormData`, or `fetch` will drop the multipart boundary.
   - `ProtonSessionManager.refreshAccessToken()` shares one `activeRefreshPromise` across concurrent `401` retries because Proton refresh tokens are single-use.
   - All requests must preserve the `x-pm-appversion: external-drive-backuptoprotondrive@<version>` header (no hyphens in `{name}` before `@` so Proton's section parser accepts it).

6. **Event cursor ordering (`lastEventId`)**:
   - Full scans capture `getLatestEventId()` **before** walking remote subdirectories, and `syncRunner` intentionally does not overwrite `lastEventId` after local uploads/trashes. This guarantees concurrent external edits during a run are picked up on the next incremental sync.

7. **SDK type import quirks (`@protontech/drive-sdk@0.23.0`)**:
   - `PrivateKey`, `PublicKey`, and `SRPModule` are not exported from `@protontech/drive-sdk`'s root entrypoint. Import `PrivateKeyReference` / `PublicKeyReference` from `@protontech/crypto` and derive `SRPModule` via `ProtonDriveClientContructorParameters['srpModule']`.

---

## 4. Development & Maintenance Conventions

- Keep external network calls gated behind `ProtonDriveAdapter` (`src/proton/client.ts`) so `remoteState` and `syncRunner` stay deterministically unit-testable offline.
- Never run `npm run build` / `npm test` skipping `typecheck`; always run `npm run typecheck && npm run build && npm test`.
- Keep [`REQUIREMENTS.md`](./REQUIREMENTS.md), [`AGENTS.md`](./AGENTS.md), [`README.md`](./README.md), and [`compose.yaml`](./compose.yaml) synchronized whenever CLI flags, environment variables, or container paths change.
