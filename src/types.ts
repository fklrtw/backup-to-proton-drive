/**
 * Shared domain types, configuration structures, synchronization plans,
 * remote state cache schemas, and adapter contracts for `backup-to-proton-drive`.
 */

/**
 * Defines a single one-way backup synchronization pair mapping a local directory
 * to a target POSIX directory inside Proton Drive.
 */
export interface DirectoryMapping {
  /** Resolved absolute path to the local source directory. */
  localDirectory: string;
  /** Normalized absolute POSIX path inside Proton Drive (always starts with `/`). */
  remoteDirectory: string;
  /** Glob patterns to ignore relative to `localDirectory`. */
  excludePatterns: string[];
  /** Whether remote files missing locally should be moved to Proton Drive Trash. */
  trashObsolete: boolean;
  /** Whether obsolete empty remote subdirectories should be moved to Trash. */
  deleteEmptyRemoteDirectories: boolean;
}

/**
 * Optional headless authentication credentials supplied via environment variables
 * or mounted secret files for unattended container execution.
 */
export interface HeadlessCredentials {
  /** Proton account username or email address. */
  username?: string | undefined;
  /** Proton account login password. */
  password?: string | undefined;
  /** Base32-encoded TOTP secret used to compute 2FA codes automatically. */
  totpSecret?: string | undefined;
  /** Secondary mailbox password for accounts using Proton two-password mode. */
  mailboxPassword?: string | undefined;
}

/**
 * Fully parsed and validated CLI and environment configuration for an application run.
 */
export interface ApplicationConfiguration {
  /** Subcommand or mode requested by the caller. */
  command: 'sync' | 'login' | 'help' | 'status-server' | 'report-failure';
  /** Ordered list of local-to-remote directory synchronization mappings. */
  mappings: DirectoryMapping[];
  /** When true, computes and prints planned actions without mutating Proton Drive or cached state. */
  dryRun: boolean;
  /** Path to the persisted Proton session token and key-passphrase file. */
  sessionFilePath: string;
  /** Path to the persisted remote tree snapshot and event cursor cache file. */
  stateFilePath: string;
  /** Path to the unencrypted JSON status summary file polled by `status-server`. */
  statusFilePath: string;
  /** Host interface bound by the `status-server` HTTP listener (defaults to `0.0.0.0`). */
  statusServerHost: string;
  /** TCP port bound by the `status-server` HTTP listener (defaults to `9108`). */
  statusServerPort: number;
  /** Maximum hours permitted since `lastSuccessAt` before `status-server` marks the backup overdue (defaults to `26`). */
  statusMaxAgeHours: number;
  /** Error message recorded when invoking the `report-failure` subcommand. */
  failureMessage?: string | undefined;
  /** Proton API host name without URL scheme (defaults to `drive-api.proton.me`). */
  apiBaseHost: string;
  /** Application semantic version used for the required `x-pm-appversion` header. */
  applicationVersion: string;
  /** Maximum number of concurrent file uploads across all mappings (defaults to `5`). */
  uploadConcurrency: number;
  /** Maximum number of local files streamed and SHA1-hashed concurrently (defaults to `8`). */
  localHashConcurrency: number;
  /** Maximum number of remote directory listings issued concurrently on full scans (defaults to `6`). */
  remoteScanConcurrency: number;
  /** Enables `@protontech/drive-sdk`'s single-request upload endpoint for files under 128 KiB. */
  enableSmallFileUpload: boolean;
  /** Enables detailed credential-safe diagnostic logging across auth, HTTP requests, and sync phases. */
  verbose: boolean;
  /** Master key bytes loaded from `DATA_ENCRYPTION_KEY_FILE` / `--encryption-key-file` to encrypt `session.json` and `state.json` at rest. */
  dataEncryptionKey?: Buffer | undefined;
  /** Explicit opt-out allowing plaintext `0600` JSON persistence when no encryption key file is configured. */
  allowPlaintextState: boolean;
  /** Optional credentials used for headless login when no valid persisted session exists. */
  headlessCredentials: HeadlessCredentials;
}

/**
 * Persisted Proton authentication session saved to disk with `0600` permissions.
 * Note that the raw login password is never persisted; only computed salted key
 * passphrases and OAuth session tokens are retained.
 */
export interface PersistedSessionData {
  /** Schema version identifier for safe forward migrations. */
  schemaVersion: 1;
  /** Proton unique session identifier (`x-pm-uid` header value). */
  sessionUid: string;
  /** Short-lived bearer access token. */
  accessToken: string;
  /** Single-use refresh token rotated on every token refresh. */
  refreshToken: string;
  /** Authenticated Proton user ID. */
  userId: string;
  /** Primary email address associated with the authenticated account. */
  email: string;
  /** Computed key passphrases indexed by Proton `UserKey.ID`. */
  keyPassphrasesByKeyId: Record<string, string>;
  /** Fallback key passphrase for legacy unsalted private keys. */
  primaryKeyPassphrase: string;
  /** ISO-8601 timestamp recording when the session was last saved or refreshed. */
  savedAtIso: string;
}

/**
 * Metadata and content digest computed by streaming a regular file on the local filesystem.
 */
export interface LocalFileEntry {
  /** Absolute path to the local file on disk. */
  absolutePath: string;
  /** POSIX-normalized path relative to the mapping's local root directory. */
  relativePath: string;
  /** Lowercase hexadecimal SHA1 digest of the file contents. */
  sha1Hash: string;
  /** File size in bytes. */
  sizeInBytes: number;
  /** Last modification timestamp reported by the local filesystem. */
  modificationTime: Date;
}

/**
 * Aggregated result of scanning a local source directory tree.
 */
export interface LocalScanResult {
  /** Map of relative POSIX file paths to local file metadata. */
  filesByRelativePath: Map<string, LocalFileEntry>;
  /** Total cumulative size in bytes across all included local files. */
  totalSizeInBytes: number;
}

/**
 * Node representation stored in the remote tree snapshot and persisted cache.
 */
export interface RemoteNodeRecord {
  /** Unique Proton Drive node UID (`<volumeId>~<linkId>`). */
  nodeUid: string;
  /** Parent folder node UID, or `null` for the My Files volume root. */
  parentNodeUid: string | null;
  /** Decrypted file or folder name. */
  name: string;
  /** Whether this node represents a file or folder. */
  nodeType: 'file' | 'folder';
  /** POSIX path relative to the mapping's `remoteDirectory` (`''` for the mapping root itself). */
  relativePath: string;
  /** Lowercase SHA1 digest claimed by the active revision for files, or `null`. */
  sha1Hash: string | null;
  /** Claimed plaintext size in bytes when available, or `null`. */
  sizeInBytes: number | null;
  /** Claimed modification time in epoch milliseconds when available, or `null`. */
  modificationTimeMs: number | null;
}

/**
 * Indexed view of all active remote files and folders within a single mapping target.
 */
export interface RemoteTreeSnapshot {
  /** UID of the mapping's remote root folder, or `null` if it does not exist yet. */
  rootNodeUid: string | null;
  /** Proton Drive volume event scope identifier for the user's My Files tree. */
  treeEventScopeId: string;
  /** All active nodes within this mapping indexed by `nodeUid`. */
  nodesByUid: Map<string, RemoteNodeRecord>;
  /** Active file nodes indexed by POSIX path relative to the mapping root. */
  filesByRelativePath: Map<string, RemoteNodeRecord>;
  /** Active folder nodes indexed by POSIX path relative to the mapping root (includes `''` for root). */
  foldersByRelativePath: Map<string, RemoteNodeRecord>;
}

/**
 * Cached remote tree state persisted to disk across one-shot runs so subsequent
 * invocations can apply incremental Drive events rather than rescanning the entire tree.
 */
export interface PersistedRemoteState {
  /** Schema version identifier for safe cache invalidation on upgrades. */
  schemaVersion: 1;
  /** Proton Drive event scope ID (volume ID) associated with the cached nodes. */
  treeEventScopeId: string;
  /** Latest processed Proton Drive volume event cursor ID. */
  lastEventId: string;
  /** Node UID of the user's My Files root folder to guard against account/volume changes. */
  myFilesRootNodeUid: string;
  /** Per-mapping cached remote node lists keyed by normalized `remoteDirectory`. */
  mappings: Record<
    string,
    {
      remoteDirectory: string;
      rootNodeUid: string | null;
      nodes: RemoteNodeRecord[];
    }
  >;
  /** ISO-8601 timestamp when the state cache was last written. */
  updatedAtIso: string;
}

/**
 * Normalized Proton Drive tree event consumed by incremental state synchronization.
 */
export type DriveTreeEvent =
  | {
      type: 'node_created' | 'node_updated';
      nodeUid: string;
      parentNodeUid?: string | undefined;
      isTrashed: boolean;
      eventId: string;
    }
  | {
      type: 'node_deleted';
      nodeUid: string;
      parentNodeUid?: string | undefined;
      eventId: string;
    }
  | {
      type: 'fast_forward' | 'tree_refresh' | 'tree_remove';
      eventId: string;
    };

/**
 * SDK-agnostic node metadata returned by a {@link ProtonDriveAdapter}.
 */
export interface RawRemoteNode {
  /** Unique Proton Drive node UID. */
  nodeUid: string;
  /** Parent node UID, or `null` for root nodes. */
  parentNodeUid: string | null;
  /** Decrypted node name (or placeholder if unreadable). */
  name: string;
  /** Node classification mapped from SDK `NodeType`. */
  nodeType: 'file' | 'folder';
  /** Volume event scope ID this node belongs to. */
  treeEventScopeId: string;
  /** Whether the node currently resides in Trash. */
  isTrashed: boolean;
  /** Lowercase hex SHA1 digest from the active revision, if available. */
  sha1Hash: string | null;
  /** Claimed plaintext size in bytes from the active revision, if available. */
  sizeInBytes: number | null;
  /** Claimed modification timestamp in milliseconds, if available. */
  modificationTimeMs: number | null;
}

/**
 * Planned zero-bandwidth rename and/or cross-folder move of an existing remote file
 * whose SHA1 digest matches a newly discovered local file path.
 */
export interface FileMoveOperation {
  /** Existing remote file node UID to relocate/rename. */
  sourceNodeUid: string;
  /** Existing relative POSIX path before the move or rename. */
  sourceRelativePath: string;
  /** Destination relative POSIX path matching the local file. */
  targetRelativePath: string;
  /** Relative POSIX path of the destination parent folder (`''` for mapping root). */
  targetDirectoryRelativePath: string;
  /** Destination filename inside `targetDirectoryRelativePath`. */
  targetFileName: string;
  /** Whether the parent folder changed. */
  needsMove: boolean;
  /** Whether the filename changed. */
  needsRename: boolean;
  /** Plaintext file size in bytes (tracks bandwidth avoided). */
  sizeInBytes: number;
}

/**
 * Planned streaming upload operation either creating a brand-new remote file
 * or appending a new revision to an existing file node.
 */
export type FileUploadOperation =
  | {
      kind: 'new';
      localFile: LocalFileEntry;
      targetDirectoryRelativePath: string;
      targetFileName: string;
    }
  | {
      kind: 'update';
      localFile: LocalFileEntry;
      existingNodeUid: string;
      targetDirectoryRelativePath: string;
      targetFileName: string;
    };

/**
 * Deterministic synchronization execution plan computed by comparing a local scan
 * against a remote tree snapshot for a single mapping.
 */
export interface SyncPlan {
  /** Missing relative folder paths sorted top-down by depth so parents precede children. */
  directoriesToCreate: string[];
  /** Existing remote files matched by SHA1 that can be moved/renamed without re-uploading. */
  movesAndRenames: FileMoveOperation[];
  /** Files requiring streaming upload (either brand new or modified revisions). */
  uploads: FileUploadOperation[];
  /** Remote file nodes absent locally that should be moved to Trash (when enabled). */
  obsoleteFileNodes: RemoteNodeRecord[];
  /** Top-most obsolete empty remote folder subtrees to move to Trash (when enabled). */
  obsoleteEmptyFolderNodes: RemoteNodeRecord[];
  /** Number of files already present remotely with identical paths and SHA1 digests. */
  unchangedCount: number;
  /** Total plaintext bytes queued for upload. */
  bytesToTransfer: number;
  /** Total plaintext bytes preserved without re-upload via move/rename operations. */
  bytesSavedByMoves: number;
}

/**
 * Execution summary metrics for a single synchronized directory mapping.
 */
export interface MappingSyncSummary {
  localDirectory: string;
  remoteDirectory: string;
  newFilesCount: number;
  updatedFilesCount: number;
  movedOrRenamedFilesCount: number;
  unchangedFilesCount: number;
  trashedFilesCount: number;
  trashedEmptyFoldersCount: number;
  failedTrashCount: number;
  bytesTransferred: number;
  bytesSavedByMoves: number;
  durationSeconds: number;
}

/**
 * Aggregated execution summary across all configured directory mappings in a run.
 */
export interface OverallSyncSummary {
  dryRun: boolean;
  usedIncrementalEvents: boolean;
  eventsProcessedCount: number;
  mappingSummaries: MappingSyncSummary[];
  totalNewFilesCount: number;
  totalUpdatedFilesCount: number;
  totalMovedOrRenamedFilesCount: number;
  totalUnchangedFilesCount: number;
  totalTrashedFilesCount: number;
  totalTrashedEmptyFoldersCount: number;
  totalFailedTrashCount: number;
  totalBytesTransferred: number;
  totalBytesSavedByMoves: number;
  totalDurationSeconds: number;
}

/**
 * Abstraction over `@protontech/drive-sdk`'s `ProtonDriveClient` allowing the sync engine,
 * incremental event state tracker, and runner to be tested deterministically with mocks.
 */
export interface ProtonDriveAdapter {
  /** Returns the user's primary My Files root folder node. */
  getMyFilesRootFolder(): Promise<RawRemoteNode>;
  /** Lists all direct non-trashed children of a remote folder. */
  listFolderChildren(parentNodeUid: string, abortSignal?: AbortSignal): Promise<RawRemoteNode[]>;
  /** Fetches metadata for a list of node UIDs, mapping missing UIDs to `null`. */
  getNodesByUids(nodeUids: string[], abortSignal?: AbortSignal): Promise<Map<string, RawRemoteNode | null>>;
  /** Returns the node ancestor chain from volume root down to `nodeUid`. */
  getNodeHierarchy(nodeUid: string): Promise<RawRemoteNode[]>;
  /** Queries the current latest volume event cursor ID without streaming events. */
  getLatestEventId(treeEventScopeId: string, abortSignal?: AbortSignal): Promise<string>;
  /** Iterates incremental tree events after `lastEventId`. */
  iterateEvents(
    treeEventScopeId: string,
    lastEventId: string,
    abortSignal?: AbortSignal,
  ): AsyncIterable<DriveTreeEvent>;
  /** Creates a new folder under `parentNodeUid`. */
  createFolder(parentNodeUid: string, folderName: string, modificationTime?: Date): Promise<RawRemoteNode>;
  /** Streams and encrypts a brand-new local file into `parentNodeUid`. */
  uploadNewFile(
    parentNodeUid: string,
    localFile: LocalFileEntry,
    abortSignal?: AbortSignal,
  ): Promise<{ nodeUid: string; revisionUid: string }>;
  /** Streams and encrypts a new revision onto an existing remote file node. */
  uploadFileRevision(
    existingNodeUid: string,
    localFile: LocalFileEntry,
    abortSignal?: AbortSignal,
  ): Promise<{ nodeUid: string; revisionUid: string }>;
  /** Renames an existing node within its parent folder. */
  renameNode(nodeUid: string, newName: string): Promise<RawRemoteNode>;
  /** Moves an existing node to `newParentNodeUid`. */
  moveNode(nodeUid: string, newParentNodeUid: string, abortSignal?: AbortSignal): Promise<void>;
  /** Moves one or more nodes to Proton Drive Trash in batches. */
  trashNodes(
    nodeUids: string[],
    abortSignal?: AbortSignal,
  ): Promise<Array<{ nodeUid: string; succeeded: boolean; errorMessage?: string | undefined }>>;
}

/**
 * Health states persisted to `status.json` across one-shot backup runs.
 */
export type RunStatusState = 'ok' | 'warning' | 'error' | 'never_run';

/**
 * Aggregate transfer and reconciliation counts persisted inside `status.json` without
 * exposing any local filesystem paths, filenames, remote mapping names, or credentials.
 */
export interface PersistedRunStatusSummary {
  mappingsCount: number;
  usedIncrementalEvents: boolean;
  eventsProcessedCount: number;
  totalNewFilesCount: number;
  totalUpdatedFilesCount: number;
  totalMovedOrRenamedFilesCount: number;
  totalUnchangedFilesCount: number;
  totalTrashedFilesCount: number;
  totalTrashedEmptyFoldersCount: number;
  totalFailedTrashCount: number;
  totalBytesTransferred: number;
  totalBytesSavedByMoves: number;
}

/**
 * Unauthenticated run telemetry payload atomically persisted to `status.json` (`STATUS_FILE`).
 */
export interface PersistedRunStatus {
  /** Schema version identifier for forward compatibility. */
  schemaVersion: 1;
  /** Outcome of the most recent recorded run (`never_run` before the first live sync). */
  status: RunStatusState;
  /** True while a live sync invocation is currently executing. */
  running: boolean;
  /** ISO-8601 timestamp when the active run started, or `null` when idle. */
  currentRunStartedAt: string | null;
  /** ISO-8601 timestamp when the last completed, failed, or externally reported run finished. */
  lastRunAt: string | null;
  /** ISO-8601 timestamp of the latest run where all local uploads/moves succeeded. */
  lastSuccessAt: string | null;
  /** Elapsed duration in seconds for the latest recorded run, or `null`. */
  durationSeconds: number | null;
  /** Sanitized, truncated single-line error description for warnings/errors, or `null`. */
  errorMessage: string | null;
  /** Aggregate file and byte counts from the latest completed run, or `null` on failure. */
  summary: PersistedRunStatusSummary | null;
}

/**
 * Live evaluated status response returned by `status-server` (`GET /status` and `GET /health`).
 */
export interface EvaluatedRunStatus extends PersistedRunStatus {
  /** ISO-8601 timestamp when `status-server` evaluated the status file. */
  checkedAt: string;
  /** Configured staleness threshold in hours (`STATUS_MAX_AGE_HOURS`, default `26`). */
  maxAgeHours: number;
  /** Elapsed hours since `lastSuccessAt`, or `null` when no successful backup has completed. */
  ageHours: number | null;
  /** True when `lastSuccessAt` is missing or older than `maxAgeHours`. */
  overdue: boolean;
  /** True when any operator attention is needed (`status !== 'ok' || overdue`). */
  problem: boolean;
  /** Convenience inverse of `problem` (`!problem`). */
  healthy: boolean;
}
