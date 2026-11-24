# backup-to-proton-drive

One-way, SHA1-verified backup synchronization from one or more local directories (`L1 -> R1, L2 -> R2, ...`) to Proton Drive using Proton's official TypeScript/JavaScript SDK ([`@protontech/drive-sdk`](https://www.npmjs.com/package/@protontech/drive-sdk)) with zero external `proton-drive-cli` binary dependency.

> [!NOTE]
> **Unofficial Client & Preview SDK Disclaimer**
> This is an **unofficial**, personal-use backup tool not affiliated with or endorsed by Proton AG. It embeds `@protontech/drive-sdk`, which Proton currently marks as an actively evolving preview SDK with upcoming cryptographic protocol updates (Crypto v2). Always verify backups independently and test changes with `--dry-run` before enabling destructive options.

---

## Features

- **Native `@protontech/drive-sdk` E2EE**: Streams and encrypts files directly in Node.js 26 without invoking external binaries or requiring `pass`/`gnupg` inside the container.
- **At-Rest AES-256-GCM Storage Encryption**: Encrypts both `/data/session.json` and `/data/state.json` on disk (`0600` permissions inside `0700` directory) using HKDF-SHA256 domain-separated keys derived from a mounted `DATA_ENCRYPTION_KEY_FILE` (compatible with Docker/Podman secrets and `systemd-creds`). Fails fast if no encryption key is mounted unless plaintext persistence is explicitly opted into.
- **Multi-Directory Mappings (`L1 -> R1, L2 -> R2, ...`)**: Configure multiple independent local-to-remote folder pairs via `--map`, `SYNC_MAPPINGS`, or a YAML/JSON config file (with full backward compatibility for `LOCAL_DIR` / `REMOTE_DIR`).
- **Incremental Event Sync (`iterateEvents`)**: Persists the encrypted remote tree cache and volume event cursor (`STATE_FILE`) between one-shot runs so subsequent timer invocations apply remote changes via Drive events instead of walking the entire remote tree every run.
- **Zero-Bandwidth Rename & Move Detection**: Matches deleted/added local paths by SHA1 digest + node UID and executes remote `renameNode` / `moveNodes` instead of re-uploading moved or renamed files.
- **File Version History & Streaming SHA1**: Uploads modified files via `getFileRevisionUploader` (creating clean revisions) and hashes local files via Node.js streams without buffering multi-GB files into RAM.
- **Glob Excludes, Dry-Run & Batched Cleanup**: Supports `.gitignore`-style exclude globs (`--exclude` / `EXCLUDE_PATTERNS` / config file), `--dry-run` previews, batched `trashNodes` cleanup, and optional `--delete-empty-dirs` pruning.
- **Built-In Telemetry & Home Assistant Integration**: Automatically records aggregate run outcomes and timestamps into `status.json` (`STATUS_FILE`), exposes an HTTP server (`status-server` on port `9108` with `/status`, `/health`, and optional bearer-token-authenticated `POST /trigger` with running/cooldown guards), supports `report-failure` for external pre-sync hooks, and includes reference [`examples/run-backup.sh`](./examples/run-backup.sh), [`systemd/backup-to-proton-drive-trigger.path`](./systemd/backup-to-proton-drive-trigger.path), and [`examples/home-assistant.yaml`](./examples/home-assistant.yaml) templates.
- **Hardened Container & Supply Chain**: Multi-stage digest-pinned `node:26-slim` image running as non-root `node`, supporting `read_only: true`, Docker/Podman secrets (`*_FILE`), exact-pinned npm dependencies, SHA-pinned GitHub Actions, `harden-runner` egress auditing, SLSA image provenance attestations, and multi-arch (`linux/amd64`, `linux/arm64`) publishing to GHCR (`ghcr.io`).

---

## Authentication & At-Rest Encryption

`@protontech/drive-sdk` does not ship with a login flow, so this tool supports two authentication modes and protects persisted session/state files on disk with **AES-256-GCM**:

### 1. Create the At-Rest Encryption Key File (Required by Default)

Create a 32+ byte secret file before running `login` or `sync` (raw `DATA_ENCRYPTION_KEY` environment variables are intentionally rejected so keys cannot leak through `docker inspect`):

```bash
mkdir -p secrets
openssl rand -base64 32 > ./secrets/data_encryption_key.txt
chmod 0400 ./secrets/data_encryption_key.txt
```

> [!TIP]
> On systemd >= 250 hosts, [`systemd/backup-to-proton-drive.service`](./systemd/backup-to-proton-drive.service) also includes a commented `systemd-creds encrypt` + `LoadCredentialEncrypted=` example to seal this key with the host's TPM2/host key. With Docker Engine, ensure container UID `1000` (`node`) can read the mounted secret file. With rootless Podman running as the service user, `$CREDENTIALS_DIRECTORY/data_encryption_key` can be bound cleanly into the container.

### 2. Choose an Authentication Mode

#### Option A: One-Time Interactive `login` (Recommended)

Authenticate interactively once and save the encrypted session (tokens + derived key passphrases, never your raw login password) into the persistent `/data` volume (`0600` permissions):

```bash
docker compose run --rm -it backup login
# Or with Podman:
# podman compose run --rm -it backup login
```

You will be prompted for your Proton username/email, password, optional TOTP 2FA code, and optional mailbox password (for two-password accounts).

#### Option B: Headless Credentials (Environment Variables / Docker Secrets)

If `/data/session.json` is missing or revoked, the container can authenticate automatically using:
- `PROTON_USERNAME` (or `PROTON_USERNAME_FILE`)
- `PROTON_PASSWORD` (or `PROTON_PASSWORD_FILE`)
- `PROTON_TOTP_SECRET` (or `PROTON_TOTP_SECRET_FILE`) — Base32 authenticator secret (if 2FA is enabled; hardware-key-only FIDO2 without TOTP is not supported headlessly)
- `PROTON_MAILBOX_PASSWORD` (or `PROTON_MAILBOX_PASSWORD_FILE`) — only for Proton two-password mode

> [!IMPORTANT]
> If you bind-mount a host directory to `/data` instead of using a named Docker/Podman volume, ensure it is writable by UID `1000` (`node` user inside the container): `chown 1000:1000 ./data && chmod 700 ./data`.

---

## Docker / Podman Compose & Systemd Timer Quickstart

1. Generate `./secrets/data_encryption_key.txt` (step above) and adapt [`compose.yaml`](./compose.yaml) (configured for `ghcr.io/fklrtw/backup-to-proton-drive:latest`, source bind mounts, `SYNC_MAPPINGS` or a mounted config file based on [`config.example.yaml`](./config.example.yaml), `profiles: ["backup"]` on `backup`, and the companion read-only `status` service).
2. Perform the one-time interactive login (or configure headless secrets):
   ```bash
   docker compose run --rm -it backup login
   ```
3. Preview your first sync with `--dry-run`:
   ```bash
   docker compose run --rm backup --dry-run
   ```
4. Run a one-shot sync manually (note `--no-deps` skips starting `status` if you haven't started it yet):
   ```bash
   docker compose run --rm backup
   ```
5. *(Optional)* Start the persistent read-only `status` HTTP telemetry companion (`http://<host>:9108/status` and `/health`):
   ```bash
   docker compose up -d
   ```
6. Schedule recurring one-shot runs via the sample systemd units in [`systemd/backup-to-proton-drive.service`](./systemd/backup-to-proton-drive.service) and [`systemd/backup-to-proton-drive.timer`](./systemd/backup-to-proton-drive.timer) (and see [`examples/run-backup.sh`](./examples/run-backup.sh) if wrapping pre-sync hooks such as Paperless-ngx `document_exporter`):
   ```bash
   sudo cp systemd/backup-to-proton-drive.service systemd/backup-to-proton-drive.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now backup-to-proton-drive.timer
   ```

---

## Home Assistant Monitoring, Health & On-Demand Trigger Endpoint

Every live `sync` writes an unauthenticated, secret-free summary file (`STATUS_FILE`, defaulting to `/data/status.json`) tracking `running`, `status` (`ok`, `warning`, `error`, `never_run`), `lastRunAt`, `lastSuccessAt`, `durationSeconds`, sanitized `errorMessage`, and aggregate transfer counts (no filenames, paths, tokens, or emails).

The `status` service in [`compose.yaml`](./compose.yaml) runs `backup-to-proton-drive status-server` mounting **only** `proton_backup_data:/data:ro` by default (no encryption key, no backup source mounts) and exposes:
- `GET /status` / `GET /status.json`: Always returns `200 OK` JSON with dynamically computed `ageHours`, `overdue` (default threshold `26` hours), `problem` (`status !== "ok" || overdue`), `healthy` (`!problem`), and trigger state (`triggerEnabled`, `triggerAvailable`, `triggerPending`, `triggerCooldownSeconds`, `triggerCooldownRemainingSeconds`, `triggerAvailableAt`) — ideal for Home Assistant's `rest:` integration.
- `GET /health`: Returns `200 OK` when `healthy === true` and `503 Service Unavailable` when `problem === true`.
- `POST /trigger` *(opt-in via `STATUS_TRIGGER_FILE` / `--trigger-file`)*: Atomically creates a trigger file (`202 Accepted`) watched by [`systemd/backup-to-proton-drive-trigger.path`](./systemd/backup-to-proton-drive-trigger.path) to start `backup-to-proton-drive.service`. Requires `Authorization: Bearer <token>` from `STATUS_TRIGGER_TOKEN_FILE` unless `ALLOW_UNAUTHENTICATED_TRIGGER=true` is explicitly set, refuses concurrent triggers while a backup is running or a trigger is already pending (`409 Conflict`), and enforces a configurable post-run/post-trigger cooldown (`STATUS_TRIGGER_COOLDOWN_SECONDS`, default `900` seconds, returning `429 Too Many Requests` with `Retry-After`).

To enable the trigger endpoint:
1. Create `./secrets/status_trigger_token.txt` (`openssl rand -base64 32 > ./secrets/status_trigger_token.txt && chmod 0400 ./secrets/status_trigger_token.txt`) and `./trigger` (`mkdir -p trigger && chown 1000:1000 trigger && chmod 700 trigger`), then uncomment the trigger lines in [`compose.yaml`](./compose.yaml).
2. Copy and enable [`systemd/backup-to-proton-drive-trigger.path`](./systemd/backup-to-proton-drive-trigger.path) alongside [`systemd/backup-to-proton-drive.service`](./systemd/backup-to-proton-drive.service) (`sudo systemctl enable --now backup-to-proton-drive-trigger.path`).

See [`examples/home-assistant.yaml`](./examples/home-assistant.yaml) for a ready-to-use Home Assistant package exposing `binary_sensor.proton_backup_needs_attention` (`device_class: problem`), `button.proton_backup_trigger` (`rest_command` + availability cooldown handling), persistent UI notifications, and a Maintenance dashboard card.

To generate a package customized with your host URL or a unique prefix for multiple backup hosts without entity ID collisions:

```bash
docker compose run --rm --no-deps status home-assistant-config \
  --prefix Paperless \
  --status-url http://192.168.1.50:9108 \
  > packages/paperless_proton_backup.yaml
```

> [!NOTE]
> Keep port `9108` bound to your trusted LAN / firewall and do not expose it publicly without authentication. External pre-sync scripts can also record failures immediately with:
> `docker compose run --rm --no-deps backup report-failure --message "Pre-sync step failed"`

---

## Configuration Reference

Mappings are resolved in the following priority order:
1. Repeatable CLI `--map` / `-m` flags (`<localDirectory>:<remoteDirectory>`)
2. Legacy CLI `--local-dir`/`--remote-dir` or positional `[LOCAL_DIR] [REMOTE_DIR]`
3. YAML/JSON config file (`--config` / `-c` or `CONFIG_FILE`)
4. `SYNC_MAPPINGS` environment variable (`"L1:R1,L2:R2"` separated by `,`, `;`, or newlines, or a JSON array)
5. Legacy `LOCAL_DIR` and `REMOTE_DIR` environment variables

### CLI Options

| Flag | Short | Description |
| :--- | :--- | :--- |
| `login` | — | Subcommand to interactively authenticate and store `session.json` |
| `status-server` | — | Subcommand to serve `/status`, `/health`, and optional `POST /trigger` HTTP telemetry |
| `report-failure` | — | Subcommand to record an external failure message into `status.json` |
| `home-assistant-config` | — | Subcommand to generate a Home Assistant YAML package for one backup host |
| `--map <local>:<remote>` | `-m` | Add a sync mapping (repeatable) |
| `--config <path>` | `-c` | Path to a YAML or JSON configuration file |
| `--exclude <glob>` | `-x` | Add a global exclude glob pattern (repeatable) |
| `--dry-run` | `-n` | Compute and print planned operations without modifying remote files or state |
| `--delete-empty-dirs` | — | Move obsolete empty remote folders to Trash |
| `--no-trash` | — | Keep obsolete remote files instead of moving them to Trash |
| `--concurrency <count>` | — | Maximum concurrent file uploads (`1`-`32`, default `5`; env: `UPLOAD_CONCURRENCY`) |
| `--small-file-upload` | — | Enable single-request SDK uploads under 128 KiB (env: `ENABLE_SMALL_FILE_UPLOAD`) |
| `--encryption-key-file <path>` | — | Path to >= 32-byte key file encrypting `session.json` and `state.json` (env: `DATA_ENCRYPTION_KEY_FILE`) |
| `--allow-plaintext-state` | — | Explicitly opt out of at-rest encryption and allow plaintext `0600` files (env: `ALLOW_PLAINTEXT_STATE`) |
| `--session-file <path>` | — | Override session file location (default `/data/session.json` or `./data/session.json`) |
| `--state-file <path>` | — | Override event/cache state file location (default `/data/state.json` or `./data/state.json`) |
| `--status-file <path>` | — | Override run telemetry status file location (default `status.json` beside `STATE_FILE`; env: `STATUS_FILE`) |
| `--status-host <host>` | — | Host interface bound by `status-server` (default `0.0.0.0`; env: `STATUS_SERVER_HOST`) |
| `--status-port <port>` | — | TCP port bound by `status-server` (`1`-`65535`, default `9108`; env: `STATUS_SERVER_PORT`) |
| `--status-max-age-hours <h>` | — | Max hours since `lastSuccessAt` before `overdue: true` (default `26`; env: `STATUS_MAX_AGE_HOURS`) |
| `--trigger-file <path>` | — | Enable `POST /trigger` by atomically writing this trigger file (env: `STATUS_TRIGGER_FILE`) |
| `--trigger-token-file <path>` | — | Path to >= 32-byte bearer token file protecting `POST /trigger` (env: `STATUS_TRIGGER_TOKEN_FILE`) |
| `--allow-unauthenticated-trigger` | — | Explicitly opt out of bearer auth on `POST /trigger` (env: `ALLOW_UNAUTHENTICATED_TRIGGER`) |
| `--trigger-cooldown-seconds <s>` | — | Minimum cooldown seconds after a run/trigger before re-triggering (`0`-`604800`, default `900`; env: `STATUS_TRIGGER_COOLDOWN_SECONDS`) |
| `--prefix <text>` | — | Prefix prepended to generated Home Assistant names, entity IDs, and `!secret` keys |
| `--status-url <url>` | — | Base `status-server` URL for `home-assistant-config` (default `http://192.168.1.50:9108`) |
| `--scan-interval <seconds>` | — | Polling interval in seconds for Home Assistant REST sensor (`10`-`86400`, default `300`) |
| `--no-trigger` | — | Omit trigger button, `rest_command`, and trigger attributes in generated Home Assistant YAML |
| `--output <path>` | `-o` | Write generated Home Assistant YAML to a file instead of `stdout` |
| `--message <text>` | — | Failure description recorded by `report-failure` (env: `FAILURE_MESSAGE`) |
| `--verbose` | `-v` | Enable detailed credential-safe diagnostic logging across auth, HTTP requests, and sync phases (env: `VERBOSE`) |
| `--local-dir` / `--remote-dir` | `-l` / `-r` | Legacy single-mapping flags |
| `--help` | `-h` | Display usage information |

---

## GitHub Actions, Security Hardening & GHCR Publishing

- [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) runs with top-level `permissions: {}` (`contents: read` on `verify`), `persist-credentials: false`, `step-security/harden-runner` in `egress-policy: audit` mode, SHA-pinned Actions, [`.node-version`](./.node-version) pinning, and `npm ci --ignore-scripts` followed by `typecheck`, `build`, and `test`.
- [`.github/workflows/docker-publish.yml`](./.github/workflows/docker-publish.yml) gates multi-arch (`linux/amd64`, `linux/arm64`) publishing behind a passing `verify` job (`needs: verify`), pins all Actions by full 40-character commit SHA and [`Dockerfile`](./Dockerfile) base images by `sha256` digest, audits runner egress with `harden-runner`, publishes to `ghcr.io/fklrtw/backup-to-proton-drive`, and attaches Sigstore SLSA build provenance attestations via `actions/attest-build-provenance`:
  ```bash
  gh attestation verify oci://ghcr.io/fklrtw/backup-to-proton-drive:latest --owner fklrtw
  ```
- [`.github/renovate.json`](./.github/renovate.json) configures the [Mend Renovate GitHub App](https://github.com/apps/renovate) for weekly dependency PRs (Mondays before 06:00 UTC) with manual review (`automerge: false`), exact npm version pinning (`:pinAllExceptPeerDependencies`), Docker/GitHub Action digest pinning, Node.js 26 version constraints, a 3-day npm release cooldown, and grouped `@protontech/*` SDK/crypto updates. Install the Mend Renovate App on your GitHub repository to activate it.

---

## Local Development

Requires **Node.js >= 26.0.0** (matching [`.node-version`](./.node-version) for native TypeScript stripping in `node --test` and ES2025 `Uint8Array` methods used by `@protontech/crypto`).

```bash
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test
node dist/index.js --help
```

## Author, Contributors & License

- **Author / Maintainer**: fklrtw (<fklrtw@gmail.com>)
- **Contributors**:
  - fklrtw (<fklrtw@gmail.com>)
  - Antigravity (Google DeepMind)
- **License**: `GPL-3.0-or-later` — see [`LICENSE`](./LICENSE) (required by `@protontech/crypto`, which is licensed under `GPL-3.0`; `@protontech/drive-sdk` is `MIT`).
