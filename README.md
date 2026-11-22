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

1. Generate `./secrets/data_encryption_key.txt` (step above) and adapt [`compose.yaml`](./compose.yaml) (configured for `ghcr.io/fklrtw/backup-to-proton-drive:latest`, source bind mounts, and `SYNC_MAPPINGS` or a mounted config file based on [`config.example.yaml`](./config.example.yaml)).
2. Perform the one-time interactive login (or configure headless secrets):
   ```bash
   docker compose run --rm -it backup login
   ```
3. Preview your first sync with `--dry-run`:
   ```bash
   docker compose run --rm backup --dry-run
   ```
4. Run a one-shot sync manually:
   ```bash
   docker compose run --rm backup
   ```
5. Schedule recurring one-shot runs via the sample systemd units in [`systemd/backup-to-proton-drive.service`](./systemd/backup-to-proton-drive.service) and [`systemd/backup-to-proton-drive.timer`](./systemd/backup-to-proton-drive.timer):
   ```bash
   sudo cp systemd/backup-to-proton-drive.service systemd/backup-to-proton-drive.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now backup-to-proton-drive.timer
   ```

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
| `--map <local>:<remote>` | `-m` | Add a sync mapping (repeatable) |
| `--config <path>` | `-c` | Path to a YAML or JSON configuration file |
| `--exclude <glob>` | `-x` | Add a global exclude glob pattern (repeatable) |
| `--dry-run` | `-n` | Compute and print planned operations without modifying remote files or state |
| `--delete-empty-dirs` | — | Move obsolete empty remote folders to Trash |
| `--no-trash` | — | Keep obsolete remote files instead of moving them to Trash |
| `--concurrency <count>` | — | Maximum concurrent file uploads (`1`-`32`, default `5`; env: `UPLOAD_CONCURRENCY`) |
| `--small-file-upload` | — | Enable single-request SDK uploads under 128 KiB (env: `ENABLE_SMALL_FILE_UPLOAD`) |
| `--encryption-key-file <path>` | — | Path to >= 32-byte key file encrypting `session.json` and `state.json` (env: `DATA_ENCRYPTION_KEY_FILE`) |
|      --allow-plaintext-state   | — | Explicitly opt out of at-rest encryption and allow plaintext `0600` files (env: `ALLOW_PLAINTEXT_STATE`) |
| `--session-file <path>` | — | Override session file location (default `/data/session.json` or `./data/session.json`) |
| `--state-file <path>` | — | Override event/cache state file location (default `/data/state.json` or `./data/state.json`) |
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
