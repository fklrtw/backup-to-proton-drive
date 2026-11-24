# Requirements Specification

## 1. Overview

`backup-to-proton-drive` is a one-shot, one-way, SHA1-verified backup synchronization CLI and container utility built on [`@protontech/drive-sdk`](https://www.npmjs.com/package/@protontech/drive-sdk) and [`@protontech/crypto`](https://www.npmjs.com/package/@protontech/crypto). It synchronizes an ordered list of local-to-remote directory mappings (`L1 -> R1, L2 -> R2, ...`) directly with Proton Drive using end-to-end encryption without invoking any external `proton-drive-cli` binary.

> [!NOTE]
> `backup-to-proton-drive` is an unofficial, personal-use tool. `@protontech/drive-sdk` is marked by Proton as a preview SDK undergoing active evolution (including upcoming Crypto v2 changes).

---

## 2. Runtime, Build & Dependency Requirements

- **Node.js Runtime**: Requires **Node.js >= 26.0.0** ([`package.json`](./package.json) `engines.node`, CI toolchain pinned via [`.node-version`](./.node-version)) for ES2025 `Uint8Array.fromBase64()` / `toBase64()` / `toHex()` support required by `@protontech/crypto`, plus native Node TypeScript stripping for `node --test`.
- **Exact-Pinned Runtime & Build Dependencies**:
  - `@protontech/drive-sdk` (`0.23.0`, MIT): E2EE Proton Drive client (`ProtonDriveClient`).
  - `@protontech/crypto` (`2.2.0`, GPL-3.0): OpenPGP endpoint (`CryptoProxy`), SRP-6a (`getSrp`, `computeKeyPassword`), and server-time synchronization.
  - `yaml` (`2.9.1`): YAML and JSON configuration parsing.
  - Dev tooling exact-pinned (`typescript@7.0.2`, `esbuild@0.25.12`, `@types/node@26.6.6`); CI and Docker install via `npm ci --ignore-scripts`.
- **Bundling & Build Tooling (`scripts/build.mjs`)**:
  - `@protontech/crypto` exposes raw `.ts` source files via `exports` and imports `"openpgp/lightweight"` (whose `package.json` `exports` map defines only `"browser"`).
  - [`scripts/build.mjs`](./scripts/build.mjs) uses `esbuild` with an `openpgpNodeResolvePlugin` redirecting `"openpgp/lightweight"` to `@protontech/openpgp`'s Node ESM build (`node_modules/openpgp/dist/node/openpgp.mjs`), outputting [`dist/index.js`](./dist/index.js) + sourcemap.
- **Container Runtime ([`Dockerfile`](./Dockerfile))**:
  - Multi-stage build pinned by `sha256` digest on `node:26-slim` (with `FROM --platform=$BUILDPLATFORM` on builder), non-root `USER node`, `/data` writable state volume (`0700`), `SESSION_FILE=/data/session.json`, `STATE_FILE=/data/state.json`, `STATUS_FILE=/data/status.json`, optional `EXPOSE 9108` for `status-server`. Compatible with `read_only: true` Compose deployments and one-shot systemd timer execution.

---

## 3. Authentication & At-Rest Storage Encryption (`src/proton/`, `src/storageEncryption.ts`)

Because `@protontech/drive-sdk` intentionally omits login/session flows, [`src/proton/auth.ts`](./src/proton/auth.ts) and [`src/storageEncryption.ts`](./src/storageEncryption.ts) implement:

1. **Mandatory At-Rest Encryption (`session.json` & `state.json`)**:
   - Both [`src/proton/sessionStore.ts`](./src/proton/sessionStore.ts) and [`src/remoteState.ts`](./src/remoteState.ts) encrypt persisted JSON atomically (`0700` dir, `0600` temp file + rename) using **AES-256-GCM** with random 32-byte per-write salts, 12-byte nonces, and **HKDF-SHA256** domain-separated keys (`backup-to-proton-drive:session:v1` vs. `backup-to-proton-drive:state:v1` also bound in GCM AAD).
   - **File-only master key**: Supplied strictly via `DATA_ENCRYPTION_KEY_FILE` / `--encryption-key-file` / YAML `encryptionKeyFile` (minimum 32 bytes; trailing `\r?\n` trimmed). Raw `DATA_ENCRYPTION_KEY` environment variables are rejected to prevent accidental exposure via container metadata (`docker inspect`).
   - **Fail-fast & fail-loud guarantees**: `login` and `sync` refuse to start without an encryption key unless `ALLOW_PLAINTEXT_STATE=true` / `--allow-plaintext-state` is explicitly set. Corrupted, tampered, swapped-purpose, wrong-key, missing-key, or unexpected plaintext files (downgrade attempts while encryption is active) throw explicit errors and never silently reset.
2. **Interactive Login Subcommand (`backup-to-proton-drive login`)**:
   - Prompts interactively (masking password and mailbox password on TTY) for Proton username/email, password, optional 2FA TOTP code, and optional two-password mailbox password (`PasswordMode === 2`).
   - Authenticates via Proton SRP-6a (`POST /core/v4/auth/info` -> `getSrp` -> `POST /core/v4/auth` with `ServerProof` verification -> optional `POST /core/v4/auth/2fa`).
   - Fetches `/core/v4/users` and `/core/v4/keys/salts`, derives salted key passphrases (`computeKeyPassword`), verifies private key unlocking, and persists [`PersistedSessionData`](./src/types.ts) (never storing the raw login password).
3. **Headless Credential Authentication**:
   - Automatically triggers when no valid session file exists (or refresh fails) if `PROTON_USERNAME` and `PROTON_PASSWORD` (or `*_FILE` Docker/Podman secret files) are configured.
   - Supports automatic RFC 6238 TOTP generation (`PROTON_TOTP_SECRET` / `*_FILE`, implemented in [`src/proton/totp.ts`](./src/proton/totp.ts)) and two-password accounts (`PROTON_MAILBOX_PASSWORD` / `*_FILE`).
   - Hardware-key-only FIDO2 accounts without TOTP and SAML/SSO-only accounts are rejected with actionable error messages.
4. **Serialized Token Refresh & Required Headers**:
   - Concurrent `401` responses share a single in-flight `POST /core/v4/auth/refresh` call to prevent single-use refresh token races.
   - All Proton API requests include `x-pm-appversion: external-drive-backuptoprotondrive@<version>` (hyphen-free product token matching Proton's `external-drive-{name}@{semver}` section parser).

---

## 4. Configuration, Multi-Mapping Precedence & Validation (`src/config.ts`)

### Supported CLI Options & Subcommands

- `login`: Interactive credential sign-in and session file persistence.
- `status-server`: HTTP telemetry server exposing `/status` (`200` JSON), `/health` (`200` healthy / `503` problem), and opt-in `POST /trigger` (`202` accepted / `401` unauthorized / `409` running or pending / `429` cooldown) for LAN monitoring and Home Assistant.
- `report-failure`: Records an external pre-sync failure description (`--message` / positional / `FAILURE_MESSAGE`) into `STATUS_FILE` while preserving `lastSuccessAt`.
- `home-assistant-config`: Pure CLI package generator rendering a Home Assistant YAML package for one backup host (`--prefix`, `--status-url`, `--scan-interval`, `--no-trigger`, `--allow-unauthenticated-trigger`, `-o`/`--output`), reading only explicit CLI flags without inheriting environment variables or `CONFIG_FILE`.
- `--map <local>:<remote>` / `-m` (repeatable): Adds a `localDirectory -> remoteDirectory` mapping. Split on the last `:/` boundary first so local paths containing colons remain valid.
- `--config <path>` / `-c`: Path to a YAML or JSON configuration file.
- `--exclude <glob>` / `-x` (repeatable): Global exclude glob patterns merged into all mappings.
- `--dry-run` / `-n`: Computes and prints all planned operations without modifying Proton Drive or `STATE_FILE`.
- `--delete-empty-dirs`: Moves obsolete empty remote subdirectories to Trash.
- `--no-trash`: Disables moving obsolete remote files to Trash.
- `--concurrency <count>`: Maximum concurrent file uploads across all mappings (`1`–`32`, default `5`; env: `UPLOAD_CONCURRENCY`).
- `--small-file-upload`: Opt-in flag enabling `@protontech/drive-sdk`'s single-request upload path for files under 128 KiB (env: `ENABLE_SMALL_FILE_UPLOAD`).
- `--encryption-key-file <path>`: Path to >= 32-byte key file encrypting `session.json` and `state.json` at rest (env: `DATA_ENCRYPTION_KEY_FILE`, YAML/JSON: `encryptionKeyFile`).
- `--allow-plaintext-state`: Explicit opt-out allowing unencrypted `0600` JSON persistence (env: `ALLOW_PLAINTEXT_STATE`, YAML/JSON: `allowPlaintextState`).
- `--session-file <path>`, `--state-file <path>`: Override persistent session and event cache paths.
- `--status-file <path>`: Override unencrypted run telemetry JSON file path (default `status.json` beside `STATE_FILE`; env: `STATUS_FILE`, YAML/JSON: `statusFile`).
- `--status-host <host>`, `--status-port <port>`, `--status-max-age-hours <hours>`: Configure `status-server` listen address (`0.0.0.0:9108`) and staleness threshold (`26` hours).
- `--trigger-file <path>`, `--trigger-token-file <path>`, `--allow-unauthenticated-trigger`, `--trigger-cooldown-seconds <seconds>`: Configure opt-in `POST /trigger` on `status-server`, its >= 32-byte file-only bearer token (`STATUS_TRIGGER_TOKEN_FILE`, rejecting raw `STATUS_TRIGGER_TOKEN` env vars) or explicit opt-out (`ALLOW_UNAUTHENTICATED_TRIGGER`), and its post-run/post-trigger cooldown (`0`–`604800`, default `900` seconds).
- `--prefix <text>`, `--status-url <url>`, `--scan-interval <seconds>`, `--no-trigger`, `-o` / `--output <path>`: Configure `home-assistant-config` output prefixing, `status-server` base URL (`http://` / `https://`), REST polling interval (`10`–`86400`), trigger omission, and optional atomic file output.
- `--message <text>`: Failure reason recorded by `report-failure` (env: `FAILURE_MESSAGE`).
- `--verbose` / `-v`: Enables credential-safe diagnostic logging across auth, API calls, and sync phases (env: `VERBOSE`, YAML/JSON: `verbose`).
- `--local-dir` / `-l`, `--remote-dir` / `-r`, or positional `[LOCAL_DIR] [REMOTE_DIR]`: Legacy single-mapping compatibility (also supports `--local-dir LOCAL REMOTE`).
- `--help` / `-h`: Prints usage text and exits `0`.

### Mapping Resolution Precedence

1. CLI `--map` flags
2. Legacy CLI `--local-dir` / `--remote-dir` or positional arguments
3. YAML/JSON configuration file `mappings`
4. `SYNC_MAPPINGS` environment variable (JSON array or entries separated by `,`, `;`, or newlines)
5. Legacy `LOCAL_DIR` and `REMOTE_DIR` environment variables

### Validation & Safeguards

- **Remote path normalization**: Normalized via `path.posix.normalize`, stripping trailing slashes on subdirectories while preserving `'/'` when targeting the My Files root directly. Relative remote paths are rejected.
- **Local directory validation**: Each local root directory is resolved via `path.resolve` and verified to exist as a directory before syncing begins.
- **Overlapping target guard**: Duplicate or nested parent/child `remoteDirectory` targets across mappings are rejected at startup to prevent one mapping from treating another mapping's remote files as obsolete and trashing them.

---

## 5. Synchronization Pipeline

The synchronization orchestrator ([`src/syncRunner.ts`](./src/syncRunner.ts)) runs globally across all configured mappings (`L1 -> R1, L2 -> R2, ...`) in six batched and bounded-concurrency phases using [`runWithConcurrency`](./src/concurrency.ts):

### Phase 1 — Parallel Local Scanning & Remote State Catch-Up ([`src/remoteState.ts`](./src/remoteState.ts), [`src/localScanner.ts`](./src/localScanner.ts), [`src/ignore.ts`](./src/ignore.ts))

- Runs remote tree synchronization simultaneously with all local directory scans (`LOCAL_HASH_CONCURRENCY`, default `8` concurrent SHA1 streams):
  - **Local scanning**: Traverses each mapping asynchronously (`fs.promises.readdir`), skips symlinks and non-regular files, prunes excluded subtrees via [`compileExcludeMatcher`](./src/ignore.ts), and computes lowercase hex SHA1 digests via constant-RAM read streams (`computeFileSha1Stream`).
  - **Incremental remote event catch-up**: When `STATE_FILE` has matching `treeEventScopeId`, `myFilesRootNodeUid`, and `lastEventId`, streams volume events via `client.iterateEvents(treeEventScopeId, lastEventId)` without walking the remote tree. Removes deleted/trashed nodes, batch-loads changed UIDs via `iterateNodes`, and falls back to full scans on `tree_refresh` / `tree_remove` events or uncached mappings.
  - **Cold bootstrap / full rescan**: Captures `lastEventId` **before** walking remote subdirectories so concurrent edits are never missed, then lists folders level-by-level with bounded concurrency (`REMOTE_SCAN_CONCURRENCY`, default `6`, using a shared single-flight path lookup cache).

### Phase 2 — Upfront Diff Planning & Zero-Bandwidth Move Detection ([`src/diffEngine.ts`](./src/diffEngine.ts))

Computes a deterministic [`SyncPlan`](./src/types.ts) for every mapping before performing any mutations:
- **Pass 1 (Exact path matches)**: Matching non-empty lowercase SHA1 is unchanged; differing, empty, or missing remote SHA1 is queued for revision upload (`uploadFileRevision`).
- **Pass 2 (Move & rename matching)**: Pairs remaining local files 1-to-1 with unmatched remote files having the same non-empty SHA1 digest into zero-bandwidth move/rename operations (`moveNode` / `renameNode`). Unpaired local files are queued as new uploads (`uploadNewFile`).
- **Directory creation & cleanup planning**: Computes missing ancestor directories sorted top-down; collects obsolete files when `trashObsolete` is enabled; when `deleteEmptyRemoteDirectories` is enabled, selects minimal top-most obsolete empty folder subtrees (never deleting the mapping root).
- On `--dry-run`, prints every planned action across all mappings and exits without modifying Proton Drive or `STATE_FILE`.

### Phase 3 — Level-by-Level Folder Creation

- Creates missing mapping root directories concurrently using a single-flight shared prefix promise cache so shared ancestors (e.g., `/Backups` for `/Backups/A` and `/Backups/B`) are created once without race conditions.
- Creates missing subdirectories across all mappings in concurrent depth waves (all depth-1 folders first, then depth-2, etc.).

### Phase 4 — Concurrent Non-Conflicting Moves & Renames

- Partitions move/rename operations into conflict-free parallel batches (executed with `UPLOAD_CONCURRENCY`) and sequential chains whenever touched source/destination/intermediate paths intersect within a mapping.

### Phase 5 — Concurrent Streaming Uploads (Fail-Fast)

- Pools all new uploads and modified revisions across all mappings into a single bounded worker pool (`UPLOAD_CONCURRENCY`, default `5` matching SDK `UploadQueue`).
- Any upload error fails fast and skips Phase 6 so obsolete remote files are never trashed after an incomplete upload.

### Phase 6 — Consolidated Bulk Trash & State Persistence

- Combines obsolete file and empty-folder UIDs across all mappings into a single `adapter.trashNodes(...)` invocation (batched by `@protontech/drive-sdk` at `100` UIDs per `trash_multiple` request).
- Deduplicates obsolete child files already covered by a top-most obsolete empty folder being trashed.
- Persists updated `PersistedRemoteState` atomically (`0600`, AES-256-GCM encrypted using `state` HKDF domain separation by default) while preserving `lastEventId` at the pre-mutation event cursor so concurrent external changes are captured on the next incremental run.

---

## 6. Run Telemetry & Read-Only Status Server ([`src/runStatus.ts`](./src/runStatus.ts), [`src/statusServer.ts`](./src/statusServer.ts))

- **Plaintext Telemetry File (`STATUS_FILE`, default `status.json` beside `STATE_FILE`)**:
  - Updated atomically on live `sync` runs (never written during `--dry-run`) across start (`running: true` while preserving previous `status` and `lastSuccessAt`), completion (`ok` or `warning` on partial trash failures while updating `lastSuccessAt`), and failure (`error` while preserving previous `lastSuccessAt` and sanitizing/redacting tokens, URL credentials, and emails from `errorMessage`).
  - Excludes local filesystem paths, filenames, remote mapping names, and authentication secrets so it can safely be served unauthenticated over a private LAN.
- **External Failure Reporting (`report-failure`)**:
  - Records external wrapper failures (such as a failed pre-sync `document_exporter` run) into `STATUS_FILE` without requiring directory mappings, encryption keys, or Proton authentication.
- **Built-In Status HTTP Server (`status-server`)**:
  - Serves `GET`/`HEAD` `/status` and `/status.json` (`200 OK` JSON with dynamically evaluated `overdue`, `ageHours`, `problem`, `healthy`, and trigger availability/cooldown fields) and `/health` (`200` when `healthy`, `503` when `problem`). Designed to run in a dedicated companion container mounting `/data:ro` (plus an optional writable `/trigger` spool directory when on-demand triggering is enabled).
  - When `STATUS_TRIGGER_FILE` (`--trigger-file`) is configured, exposes `POST /trigger` protected by a constant-time SHA-256 comparison against a >= 32-byte bearer token read from `STATUS_TRIGGER_TOKEN_FILE` (unless `ALLOW_UNAUTHENTICATED_TRIGGER=true` is explicitly set). Rejects concurrent runs (`running: true` -> `409 Conflict`), pending trigger files (`409 Conflict`), and cooldown periods measured from `max(lastRunAt, lastTriggerAcceptedAt) + cooldownSeconds` (`429 Too Many Requests` with `Retry-After`), and atomically creates the trigger file (`flag: 'wx'`) watched by [`systemd/backup-to-proton-drive-trigger.path`](./systemd/backup-to-proton-drive-trigger.path) and cleaned up via `ExecStopPost` in [`systemd/backup-to-proton-drive.service`](./systemd/backup-to-proton-drive.service).
- **Home Assistant Package Generator (`home-assistant-config`, [`src/homeAssistantConfig.ts`](./src/homeAssistantConfig.ts))**:
  - Generates a self-contained Home Assistant package (`rest:`, `rest_command:`, `template:`, `automation:`) matching [`examples/home-assistant.yaml`](./examples/home-assistant.yaml) byte-for-byte with default options and deriving consistent prefixed display names, slugified entity IDs, `!secret` keys, and notification/Spook IDs when `--prefix` is supplied for multi-host deployments.

---

## 7. Signals & Exit Codes ([`src/index.ts`](./src/index.ts))

- `SIGINT` aborts active operations via `AbortController`, releases `CryptoProxy` keys, closes `status-server` if running, and exits `130`.
- `SIGTERM` aborts active operations cleanly via `AbortController`, releases `CryptoProxy` keys, closes `status-server` if running, and exits `143`.
- A second `SIGINT`/`SIGTERM` forces immediate termination with the same signal exit code.
- Normal sync completion, `report-failure`, or `--help` exits `0`; invalid configuration, authentication failures, or fatal upload/IO errors log `Sync error: <message>` to `stderr` and exit `1`.

---

## 8. Known SDK & Operational Caveats

- **Preview SDK & Crypto v2**: `@protontech/drive-sdk` (`0.23.0`) is under active Proton development; future Crypto v2 protocol upgrades may require updating SDK and crypto dependencies.
- **Auth endpoint stability**: SRP login (`core/v4/auth*`, `users`, `addresses`, `keys/*`) talks directly to Proton Core APIs because `@protontech/drive-sdk` does not ship an auth package.
- **No cross-mapping moves**: Move/rename matching operates within each mapping's subtree (`L1 -> R1` independently of `L2 -> R2`).
- **Empty local directories**: Empty local directories are not mirrored remotely; only directories containing at least one included file are created.
- **Rate limits & retries**: Handled internally by `@protontech/drive-sdk`'s `DriveAPIService` (`429` `retry-after`, `5xx`, and transient network/timeout retries) plus automatic single-flight `401` access token refresh in [`createProtonHttpClient`](./src/proton/client.ts).
