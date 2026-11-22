import { runWithConcurrency } from './concurrency.ts';
import {
  readProtectedJsonFile,
  type StorageEncryptionOptions,
  writeProtectedJsonFile,
} from './storageEncryption.ts';
import type {
  DirectoryMapping,
  PersistedRemoteState,
  ProtonDriveAdapter,
  RawRemoteNode,
  RemoteNodeRecord,
  RemoteTreeSnapshot,
} from './types.ts';

/**
 * Default maximum number of remote folder listings executed concurrently during full scans.
 */
const DEFAULT_REMOTE_SCAN_CONCURRENCY = 6;

/**
 * Reads persisted remote tree state and volume event cursor from disk (decrypting via
 * `encryptionOptions.encryptionKey` when encrypted).
 * Returns `null` when the file does not exist yet or fails plaintext schema checks;
 * throws loudly on missing keys, wrong keys, tampered ciphertexts, or downgrade attempts.
 *
 * @param stateFilePath - Absolute path to the persisted state file.
 * @param encryptionOptions - At-rest encryption key and plaintext opt-out policy.
 * @returns Parsed {@link PersistedRemoteState} or `null`.
 */
export async function loadPersistedRemoteState(
  stateFilePath: string,
  encryptionOptions: StorageEncryptionOptions,
): Promise<PersistedRemoteState | null> {
  const parsedPayload = await readProtectedJsonFile({
    filePath: stateFilePath,
    purpose: 'state',
    encryptionOptions,
  });

  if (parsedPayload === null || typeof parsedPayload !== 'object' || Array.isArray(parsedPayload)) {
    return null;
  }

  const candidate = parsedPayload as Partial<PersistedRemoteState>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.treeEventScopeId !== 'string' ||
    typeof candidate.lastEventId !== 'string' ||
    typeof candidate.myFilesRootNodeUid !== 'string' ||
    typeof candidate.mappings !== 'object' ||
    candidate.mappings === null
  ) {
    return null;
  }

  return candidate as PersistedRemoteState;
}

/**
 * Atomically persists remote tree state and the latest processed event ID to disk
 * with restrictive `0600` file permissions inside a `0700` directory, encrypted with
 * AES-256-GCM by default.
 *
 * @param stateFilePath - Destination path for the state cache file.
 * @param state - State payload to serialize.
 * @param encryptionOptions - At-rest encryption key and plaintext opt-out policy.
 */
export async function savePersistedRemoteState(
  stateFilePath: string,
  state: PersistedRemoteState,
  encryptionOptions: StorageEncryptionOptions,
): Promise<void> {
  await writeProtectedJsonFile({
    filePath: stateFilePath,
    purpose: 'state',
    payload: state,
    encryptionOptions,
  });
}

/**
 * Builds an indexed {@link RemoteTreeSnapshot} from a flat list of cached descendant nodes
 * for a single mapping.
 *
 * @param rootNodeUid - UID of the mapping's remote root folder, or `null` if not created yet.
 * @param treeEventScopeId - Volume event scope ID.
 * @param descendantNodes - Flat array of cached child/descendant node records.
 * @returns Indexed {@link RemoteTreeSnapshot}.
 */
export function buildSnapshotFromNodes(
  rootNodeUid: string | null,
  treeEventScopeId: string,
  descendantNodes: readonly RemoteNodeRecord[],
): RemoteTreeSnapshot {
  const nodesByUid = new Map<string, RemoteNodeRecord>();
  const filesByRelativePath = new Map<string, RemoteNodeRecord>();
  const foldersByRelativePath = new Map<string, RemoteNodeRecord>();

  if (rootNodeUid !== null) {
    const syntheticRootRecord: RemoteNodeRecord = {
      nodeUid: rootNodeUid,
      parentNodeUid: null,
      name: '',
      nodeType: 'folder',
      relativePath: '',
      sha1Hash: null,
      sizeInBytes: null,
      modificationTimeMs: null,
    };
    nodesByUid.set(rootNodeUid, syntheticRootRecord);
    foldersByRelativePath.set('', syntheticRootRecord);
  }

  for (const nodeRecord of descendantNodes) {
    const copiedRecord: RemoteNodeRecord = { ...nodeRecord };
    nodesByUid.set(copiedRecord.nodeUid, copiedRecord);
    if (copiedRecord.nodeType === 'folder') {
      foldersByRelativePath.set(copiedRecord.relativePath, copiedRecord);
    } else {
      filesByRelativePath.set(copiedRecord.relativePath, copiedRecord);
    }
  }

  return {
    rootNodeUid,
    treeEventScopeId,
    nodesByUid,
    filesByRelativePath,
    foldersByRelativePath,
  };
}

/**
 * Extracts descendant records (excluding the synthetic root `''` entry) from a snapshot
 * for compact JSON persistence.
 *
 * @param snapshot - Snapshot to serialize.
 * @returns Sorted array of descendant {@link RemoteNodeRecord} entries.
 */
export function snapshotToDescendantRecords(snapshot: RemoteTreeSnapshot): RemoteNodeRecord[] {
  const descendants: RemoteNodeRecord[] = [];
  for (const nodeRecord of snapshot.nodesByUid.values()) {
    if (nodeRecord.relativePath !== '') {
      descendants.push({ ...nodeRecord });
    }
  }
  return descendants.sort((firstRecord, secondRecord) =>
    firstRecord.relativePath.localeCompare(secondRecord.relativePath),
  );
}

/**
 * Resolves a normalized POSIX remote directory path starting from the user's My Files root
 * by walking child folders segment by segment. Returns `null` if any segment does not exist.
 *
 * @param adapter - Proton Drive adapter.
 * @param myFilesRootNode - User's My Files root node.
 * @param remoteDirectory - Normalized remote POSIX path starting with `/`.
 * @param abortSignal - Optional cancellation signal.
 * @returns Resolved folder node, or `null` if the remote path does not exist yet.
 */
export async function resolveRemoteDirectory(
  adapter: ProtonDriveAdapter,
  myFilesRootNode: RawRemoteNode,
  remoteDirectory: string,
  abortSignal?: AbortSignal,
): Promise<RawRemoteNode | null> {
  if (remoteDirectory === '/') {
    return myFilesRootNode;
  }

  const pathSegments = remoteDirectory.split('/').filter((segment) => segment.length > 0);
  let currentFolder = myFilesRootNode;

  for (const segmentName of pathSegments) {
    abortSignal?.throwIfAborted();
    const children = await adapter.listFolderChildren(currentFolder.nodeUid, abortSignal);
    const matchingFolder = children.find(
      (childNode) => !childNode.isTrashed && childNode.nodeType === 'folder' && childNode.name === segmentName,
    );
    if (!matchingFolder) {
      return null;
    }
    currentFolder = matchingFolder;
  }

  return currentFolder;
}

/**
 * Ensures all segments along `remoteDirectory` exist on Proton Drive, creating missing
 * folders top-down from the user's My Files root.
 *
 * @param adapter - Proton Drive adapter.
 * @param myFilesRootNode - User's My Files root node.
 * @param remoteDirectory - Normalized remote POSIX path starting with `/`.
 * @param abortSignal - Optional cancellation signal.
 * @returns Existing or newly created target folder node.
 */
export async function ensureRemoteDirectoryPath(
  adapter: ProtonDriveAdapter,
  myFilesRootNode: RawRemoteNode,
  remoteDirectory: string,
  abortSignal?: AbortSignal,
): Promise<RawRemoteNode> {
  if (remoteDirectory === '/') {
    return myFilesRootNode;
  }

  const pathSegments = remoteDirectory.split('/').filter((segment) => segment.length > 0);
  let currentFolder = myFilesRootNode;

  for (const segmentName of pathSegments) {
    abortSignal?.throwIfAborted();
    const children = await adapter.listFolderChildren(currentFolder.nodeUid, abortSignal);
    const existingFolder = children.find(
      (childNode) => !childNode.isTrashed && childNode.nodeType === 'folder' && childNode.name === segmentName,
    );

    if (existingFolder) {
      currentFolder = existingFolder;
    } else {
      currentFolder = await adapter.createFolder(currentFolder.nodeUid, segmentName);
    }
  }

  return currentFolder;
}

/**
 * Converts a {@link RawRemoteNode} into a {@link RemoteNodeRecord} at `relativePath`.
 *
 * @param rawNode - SDK-agnostic remote node.
 * @param relativePath - POSIX path relative to the mapping root.
 * @returns Normalized {@link RemoteNodeRecord}.
 */
function rawNodeToRecord(rawNode: RawRemoteNode, relativePath: string): RemoteNodeRecord {
  return {
    nodeUid: rawNode.nodeUid,
    parentNodeUid: rawNode.parentNodeUid,
    name: rawNode.name,
    nodeType: rawNode.nodeType,
    relativePath,
    sha1Hash: rawNode.sha1Hash ? rawNode.sha1Hash.toLowerCase() : null,
    sizeInBytes: rawNode.sizeInBytes,
    modificationTimeMs: rawNode.modificationTimeMs,
  };
}

/**
 * Breadth-first level-by-level traversal indexing all active descendant files and folders
 * inside a remote folder subtree using bounded concurrency across sibling folders.
 *
 * @param adapter - Proton Drive adapter.
 * @param rootFolderNode - Subtree root folder node.
 * @param relativePrefix - Relative POSIX prefix for children of `rootFolderNode` (`''` at mapping root).
 * @param abortSignal - Optional cancellation signal.
 * @param scanConcurrency - Maximum number of concurrent `listFolderChildren` calls (defaults to `6`).
 * @returns Deterministically sorted flat array of descendant {@link RemoteNodeRecord} entries.
 */
export async function scanRemoteSubtree(
  adapter: ProtonDriveAdapter,
  rootFolderNode: RawRemoteNode,
  relativePrefix = '',
  abortSignal?: AbortSignal,
  scanConcurrency = DEFAULT_REMOTE_SCAN_CONCURRENCY,
): Promise<RemoteNodeRecord[]> {
  const collectedRecords: RemoteNodeRecord[] = [];
  let currentLevelFolders: Array<{ folderNodeUid: string; prefix: string }> = [
    { folderNodeUid: rootFolderNode.nodeUid, prefix: relativePrefix },
  ];

  while (currentLevelFolders.length > 0) {
    abortSignal?.throwIfAborted();

    const levelResults = await runWithConcurrency(
      currentLevelFolders,
      scanConcurrency,
      async (folderEntry) => ({
        prefix: folderEntry.prefix,
        childNodes: await adapter.listFolderChildren(folderEntry.folderNodeUid, abortSignal),
      }),
      abortSignal,
    );

    const nextLevelFolders: Array<{ folderNodeUid: string; prefix: string }> = [];

    for (const levelResult of levelResults) {
      for (const childNode of levelResult.childNodes) {
        if (childNode.isTrashed) {
          continue;
        }

        const childRelativePath = levelResult.prefix
          ? `${levelResult.prefix}/${childNode.name}`
          : childNode.name;
        collectedRecords.push(rawNodeToRecord(childNode, childRelativePath));

        if (childNode.nodeType === 'folder') {
          nextLevelFolders.push({
            folderNodeUid: childNode.nodeUid,
            prefix: childRelativePath,
          });
        }
      }
    }

    currentLevelFolders = nextLevelFolders;
  }

  return collectedRecords.sort((firstRecord, secondRecord) =>
    firstRecord.relativePath.localeCompare(secondRecord.relativePath),
  );
}

/**
 * Removes a node and any cached descendant nodes whose parent chain passes through `targetNodeUid`.
 *
 * @param snapshot - Mutable snapshot to prune.
 * @param targetNodeUid - Node UID to remove along with its subtree.
 */
export function removeNodeAndDescendantsFromSnapshot(
  snapshot: RemoteTreeSnapshot,
  targetNodeUid: string,
): void {
  // Never erase the mapping root itself via this helper.
  if (targetNodeUid === snapshot.rootNodeUid) {
    return;
  }

  const uidsToRemove = new Set<string>();
  const removalQueue: string[] = [targetNodeUid];

  while (removalQueue.length > 0) {
    const currentUid = removalQueue.shift();
    if (!currentUid || uidsToRemove.has(currentUid)) {
      continue;
    }
    uidsToRemove.add(currentUid);

    for (const candidateNode of snapshot.nodesByUid.values()) {
      if (candidateNode.parentNodeUid === currentUid && !uidsToRemove.has(candidateNode.nodeUid)) {
        removalQueue.push(candidateNode.nodeUid);
      }
    }
  }

  for (const uidToRemove of uidsToRemove) {
    const existingRecord = snapshot.nodesByUid.get(uidToRemove);
    if (!existingRecord) {
      continue;
    }
    snapshot.nodesByUid.delete(uidToRemove);
    if (existingRecord.nodeType === 'folder') {
      snapshot.foldersByRelativePath.delete(existingRecord.relativePath);
    } else {
      snapshot.filesByRelativePath.delete(existingRecord.relativePath);
    }
  }
}

/**
 * Inserts or updates a node record inside `snapshot` and updates path lookup maps.
 * When a folder's `relativePath` changes, all cached descendants beneath it are re-indexed
 * cleanly as well.
 *
 * @param snapshot - Mutable snapshot to update.
 * @param updatedRecord - New node record state.
 */
export function upsertNodeInSnapshot(
  snapshot: RemoteTreeSnapshot,
  updatedRecord: RemoteNodeRecord,
): void {
  const previousRecord = snapshot.nodesByUid.get(updatedRecord.nodeUid);
  if (previousRecord) {
    if (previousRecord.nodeType === 'folder') {
      snapshot.foldersByRelativePath.delete(previousRecord.relativePath);
    } else {
      snapshot.filesByRelativePath.delete(previousRecord.relativePath);
    }
  }

  snapshot.nodesByUid.set(updatedRecord.nodeUid, updatedRecord);
  if (updatedRecord.nodeType === 'folder') {
    snapshot.foldersByRelativePath.set(updatedRecord.relativePath, updatedRecord);
  } else {
    snapshot.filesByRelativePath.set(updatedRecord.relativePath, updatedRecord);
  }

  if (
    updatedRecord.nodeType === 'folder' &&
    previousRecord &&
    previousRecord.nodeType === 'folder' &&
    previousRecord.relativePath !== updatedRecord.relativePath
  ) {
    // Update all descendants' relative paths when a cached folder was renamed or moved.
    const oldPrefix = `${previousRecord.relativePath}/`;
    const descendantsToReindex: RemoteNodeRecord[] = [];
    for (const candidate of snapshot.nodesByUid.values()) {
      if (candidate.nodeUid !== updatedRecord.nodeUid && candidate.relativePath.startsWith(oldPrefix)) {
        descendantsToReindex.push(candidate);
      }
    }

    for (const descendant of descendantsToReindex) {
      if (descendant.nodeType === 'folder') {
        snapshot.foldersByRelativePath.delete(descendant.relativePath);
      } else {
        snapshot.filesByRelativePath.delete(descendant.relativePath);
      }

      const suffix = descendant.relativePath.slice(oldPrefix.length);
      descendant.relativePath = updatedRecord.relativePath ? `${updatedRecord.relativePath}/${suffix}` : suffix;

      if (descendant.nodeType === 'folder') {
        snapshot.foldersByRelativePath.set(descendant.relativePath, descendant);
      } else {
        snapshot.filesByRelativePath.set(descendant.relativePath, descendant);
      }
    }
  }
}

/**
 * Resolves a changed node's relative path inside a mapping if it resides beneath `mappingRootUid`,
 * falling back to `adapter.getNodeHierarchy` when intermediate ancestors are not cached yet.
 *
 * @returns Relative path inside the mapping, or `null` if the node belongs outside that mapping.
 */
async function resolveRelativePathInsideMapping(
  adapter: ProtonDriveAdapter,
  snapshot: RemoteTreeSnapshot,
  rawNode: RawRemoteNode,
): Promise<string | null> {
  if (snapshot.rootNodeUid === null) {
    return null;
  }

  if (rawNode.nodeUid === snapshot.rootNodeUid) {
    return '';
  }

  if (rawNode.parentNodeUid !== null) {
    const cachedParent = snapshot.nodesByUid.get(rawNode.parentNodeUid);
    if (cachedParent && cachedParent.nodeType === 'folder') {
      return cachedParent.relativePath ? `${cachedParent.relativePath}/${rawNode.name}` : rawNode.name;
    }
  }

  // Fallback to hierarchy lookup when parent isn't cached (e.g., folder created + populated
  // before the next incremental sync, or moved in from another branch).
  const hierarchy = await adapter.getNodeHierarchy(rawNode.nodeUid);
  const rootIndex = hierarchy.findIndex((ancestorNode) => ancestorNode.nodeUid === snapshot.rootNodeUid);
  if (rootIndex === -1) {
    return null;
  }

  const relativeSegments: string[] = [];
  for (let index = rootIndex + 1; index < hierarchy.length; index++) {
    const segmentNode = hierarchy[index];
    if (segmentNode) {
      relativeSegments.push(segmentNode.name);
      // Cache any newly discovered intermediate folder along the path as well.
      if (index < hierarchy.length - 1 && segmentNode.nodeType === 'folder') {
        const intermediatePath = relativeSegments.join('/');
        if (!snapshot.nodesByUid.has(segmentNode.nodeUid)) {
          upsertNodeInSnapshot(snapshot, rawNodeToRecord(segmentNode, intermediatePath));
        }
      }
    }
  }

  return relativeSegments.join('/');
}

/**
 * Synchronizes remote tree snapshots for all configured mappings.
 *
 * Uses cached state plus `@protontech/drive-sdk` tree events (`iterateEvents`) when a valid
 * `PersistedRemoteState` is available, falling back automatically to a full subtree scan
 * on first run, account/scope change, or `tree_refresh` / `tree_remove` events.
 *
 * @param options - Adapter, target mappings, optional persisted state, and abort signal.
 * @returns Updated persisted state, per-mapping snapshots, and telemetry counters.
 */
export async function synchronizeRemoteState(options: {
  adapter: ProtonDriveAdapter;
  mappings: readonly DirectoryMapping[];
  existingState: PersistedRemoteState | null;
  abortSignal?: AbortSignal;
  remoteScanConcurrency?: number | undefined;
}): Promise<{
  state: PersistedRemoteState;
  snapshotsByRemoteDirectory: Map<string, RemoteTreeSnapshot>;
  usedIncrementalEvents: boolean;
  eventsProcessedCount: number;
}> {
  const { adapter, mappings, existingState, abortSignal, remoteScanConcurrency } = options;
  const scanConcurrency = remoteScanConcurrency ?? DEFAULT_REMOTE_SCAN_CONCURRENCY;
  const myFilesRoot = await adapter.getMyFilesRootFolder();
  const treeEventScopeId = myFilesRoot.treeEventScopeId;

  // Single-flight cache shared across concurrent mapping root lookups so shared parent
  // directories (e.g. `/Backups` for `/Backups/A` and `/Backups/B`) are listed only once.
  const folderResolutionCache = new Map<string, Promise<RawRemoteNode | null>>();
  folderResolutionCache.set('/', Promise.resolve(myFilesRoot));

  function resolveRemoteDirectoryShared(remoteDirectory: string): Promise<RawRemoteNode | null> {
    const cachedPromise = folderResolutionCache.get(remoteDirectory);
    if (cachedPromise) {
      return cachedPromise;
    }

    const resolutionPromise = (async () => {
      const lastSlashIndex = remoteDirectory.lastIndexOf('/');
      const parentRemotePath = lastSlashIndex <= 0 ? '/' : remoteDirectory.slice(0, lastSlashIndex);
      const segmentName = remoteDirectory.slice(lastSlashIndex + 1);

      const parentFolder = await resolveRemoteDirectoryShared(parentRemotePath);
      if (!parentFolder) {
        return null;
      }

      abortSignal?.throwIfAborted();
      const children = await adapter.listFolderChildren(parentFolder.nodeUid, abortSignal);
      return (
        children.find(
          (childNode) =>
            !childNode.isTrashed && childNode.nodeType === 'folder' && childNode.name === segmentName,
        ) ?? null
      );
    })();

    folderResolutionCache.set(remoteDirectory, resolutionPromise);
    return resolutionPromise;
  }

  const canAttemptIncremental =
    existingState !== null &&
    existingState.schemaVersion === 1 &&
    existingState.treeEventScopeId === treeEventScopeId &&
    existingState.myFilesRootNodeUid === myFilesRoot.nodeUid &&
    existingState.lastEventId.length > 0;

  if (canAttemptIncremental) {
    const snapshotsByRemoteDirectory = new Map<string, RemoteTreeSnapshot>();
    const uncachedMappings: DirectoryMapping[] = [];

    for (const mapping of mappings) {
      const cachedMappingEntry = existingState.mappings[mapping.remoteDirectory];
      if (cachedMappingEntry && cachedMappingEntry.rootNodeUid !== null) {
        snapshotsByRemoteDirectory.set(
          mapping.remoteDirectory,
          buildSnapshotFromNodes(cachedMappingEntry.rootNodeUid, treeEventScopeId, cachedMappingEntry.nodes),
        );
      } else {
        uncachedMappings.push(mapping);
      }
    }

    let latestEventId = existingState.lastEventId;
    let eventsProcessedCount = 0;
    let requiresFullRescan = false;
    const deletedNodeUids = new Set<string>();
    const changedNodeUids = new Set<string>();
    const createdNodeUids = new Set<string>();

    for await (const treeEvent of adapter.iterateEvents(treeEventScopeId, existingState.lastEventId, abortSignal)) {
      eventsProcessedCount++;

      if (treeEvent.type === 'tree_refresh' || treeEvent.type === 'tree_remove') {
        requiresFullRescan = true;
        break;
      }

      if (treeEvent.eventId && treeEvent.eventId !== 'none') {
        latestEventId = treeEvent.eventId;
      }

      if (treeEvent.type === 'node_deleted') {
        deletedNodeUids.add(treeEvent.nodeUid);
        changedNodeUids.delete(treeEvent.nodeUid);
        createdNodeUids.delete(treeEvent.nodeUid);
      } else if (treeEvent.type === 'node_created' || treeEvent.type === 'node_updated') {
        if (treeEvent.isTrashed) {
          deletedNodeUids.add(treeEvent.nodeUid);
          changedNodeUids.delete(treeEvent.nodeUid);
          createdNodeUids.delete(treeEvent.nodeUid);
        } else {
          changedNodeUids.add(treeEvent.nodeUid);
          deletedNodeUids.delete(treeEvent.nodeUid);
          if (treeEvent.type === 'node_created') {
            createdNodeUids.add(treeEvent.nodeUid);
          }
        }
      }
    }

    if (!requiresFullRescan) {
      // Check if any cached mapping's root folder itself was deleted or updated.
      for (const mapping of mappings) {
        const snapshot = snapshotsByRemoteDirectory.get(mapping.remoteDirectory);
        if (!snapshot || snapshot.rootNodeUid === null) {
          continue;
        }
        if (deletedNodeUids.has(snapshot.rootNodeUid)) {
          snapshotsByRemoteDirectory.set(
            mapping.remoteDirectory,
            buildSnapshotFromNodes(null, treeEventScopeId, []),
          );
          deletedNodeUids.delete(snapshot.rootNodeUid);
        } else if (changedNodeUids.has(snapshot.rootNodeUid)) {
          // Mapping root was renamed or moved; re-resolve its remote path directly.
          uncachedMappings.push(mapping);
          snapshotsByRemoteDirectory.delete(mapping.remoteDirectory);
          changedNodeUids.delete(snapshot.rootNodeUid);
        }
      }

      // Prune deleted nodes from all cached snapshots.
      for (const deletedUid of deletedNodeUids) {
        for (const snapshot of snapshotsByRemoteDirectory.values()) {
          if (snapshot.nodesByUid.has(deletedUid)) {
            removeNodeAndDescendantsFromSnapshot(snapshot, deletedUid);
          }
        }
      }

      // Batch-load and apply modified/created nodes.
      if (changedNodeUids.size > 0) {
        const fetchedNodesByUid = await adapter.getNodesByUids(Array.from(changedNodeUids), abortSignal);

        // Process folders before files so newly created parent folders exist in cache first.
        const sortedChangedEntries = Array.from(fetchedNodesByUid.entries()).sort(
          ([, firstNode], [, secondNode]) => {
            const firstPriority = firstNode?.nodeType === 'folder' ? 0 : 1;
            const secondPriority = secondNode?.nodeType === 'folder' ? 0 : 1;
            return firstPriority - secondPriority;
          },
        );

        for (const [nodeUid, rawNode] of sortedChangedEntries) {
          if (rawNode === null || rawNode.isTrashed) {
            for (const snapshot of snapshotsByRemoteDirectory.values()) {
              if (snapshot.nodesByUid.has(nodeUid)) {
                removeNodeAndDescendantsFromSnapshot(snapshot, nodeUid);
              }
            }
            continue;
          }

          for (const snapshot of snapshotsByRemoteDirectory.values()) {
            const resolvedRelativePath = await resolveRelativePathInsideMapping(adapter, snapshot, rawNode);
            if (resolvedRelativePath === null || resolvedRelativePath === '') {
              // If the node previously lived inside this mapping and moved out, remove it.
              if (snapshot.nodesByUid.has(nodeUid)) {
                removeNodeAndDescendantsFromSnapshot(snapshot, nodeUid);
              }
              continue;
            }

            const wasPreviouslyKnownFolder = snapshot.nodesByUid.get(nodeUid)?.nodeType === 'folder';
            upsertNodeInSnapshot(snapshot, rawNodeToRecord(rawNode, resolvedRelativePath));

            // If a pre-populated folder moved into this mapping from outside via `node_updated`,
            // scan its children because existing descendants do not emit individual events.
            if (
              rawNode.nodeType === 'folder' &&
              !wasPreviouslyKnownFolder &&
              !createdNodeUids.has(nodeUid)
            ) {
              const nestedDescendants = await scanRemoteSubtree(
                adapter,
                rawNode,
                resolvedRelativePath,
                abortSignal,
                scanConcurrency,
              );
              for (const descendant of nestedDescendants) {
                upsertNodeInSnapshot(snapshot, descendant);
              }
            }
          }
        }
      }

      // Scan any newly added or previously non-existent mappings concurrently.
      const scannedUncachedSnapshots = await runWithConcurrency(
        uncachedMappings,
        scanConcurrency,
        async (mapping) => {
          const targetFolder = await resolveRemoteDirectoryShared(mapping.remoteDirectory);
          if (!targetFolder) {
            return {
              remoteDirectory: mapping.remoteDirectory,
              snapshot: buildSnapshotFromNodes(null, treeEventScopeId, []),
            };
          }
          const scannedRecords = await scanRemoteSubtree(
            adapter,
            targetFolder,
            '',
            abortSignal,
            scanConcurrency,
          );
          return {
            remoteDirectory: mapping.remoteDirectory,
            snapshot: buildSnapshotFromNodes(targetFolder.nodeUid, treeEventScopeId, scannedRecords),
          };
        },
        abortSignal,
      );

      for (const scannedEntry of scannedUncachedSnapshots) {
        snapshotsByRemoteDirectory.set(scannedEntry.remoteDirectory, scannedEntry.snapshot);
      }

      const persistedMappings: PersistedRemoteState['mappings'] = {};
      for (const mapping of mappings) {
        const snapshot = snapshotsByRemoteDirectory.get(mapping.remoteDirectory);
        if (snapshot) {
          persistedMappings[mapping.remoteDirectory] = {
            remoteDirectory: mapping.remoteDirectory,
            rootNodeUid: snapshot.rootNodeUid,
            nodes: snapshotToDescendantRecords(snapshot),
          };
        }
      }

      return {
        state: {
          schemaVersion: 1,
          treeEventScopeId,
          lastEventId: latestEventId,
          myFilesRootNodeUid: myFilesRoot.nodeUid,
          mappings: persistedMappings,
          updatedAtIso: new Date().toISOString(),
        },
        snapshotsByRemoteDirectory,
        usedIncrementalEvents: true,
        eventsProcessedCount,
      };
    }
  }

  // Full bootstrap / rescan path: capture the event cursor BEFORE walking remote folders
  // so no remote mutations occurring during the scan are skipped on the next incremental run.
  const capturedEventId = await adapter.getLatestEventId(treeEventScopeId, abortSignal);
  const snapshotsByRemoteDirectory = new Map<string, RemoteTreeSnapshot>();
  const persistedMappings: PersistedRemoteState['mappings'] = {};

  const fullScanResults = await runWithConcurrency(
    mappings,
    scanConcurrency,
    async (mapping) => {
      abortSignal?.throwIfAborted();
      const targetFolder = await resolveRemoteDirectoryShared(mapping.remoteDirectory);
      if (!targetFolder) {
        return {
          remoteDirectory: mapping.remoteDirectory,
          rootNodeUid: null as string | null,
          records: [] as RemoteNodeRecord[],
          snapshot: buildSnapshotFromNodes(null, treeEventScopeId, []),
        };
      }

      const scannedRecords = await scanRemoteSubtree(
        adapter,
        targetFolder,
        '',
        abortSignal,
        scanConcurrency,
      );
      return {
        remoteDirectory: mapping.remoteDirectory,
        rootNodeUid: targetFolder.nodeUid,
        records: scannedRecords,
        snapshot: buildSnapshotFromNodes(targetFolder.nodeUid, treeEventScopeId, scannedRecords),
      };
    },
    abortSignal,
  );

  for (const scanEntry of fullScanResults) {
    snapshotsByRemoteDirectory.set(scanEntry.remoteDirectory, scanEntry.snapshot);
    persistedMappings[scanEntry.remoteDirectory] = {
      remoteDirectory: scanEntry.remoteDirectory,
      rootNodeUid: scanEntry.rootNodeUid,
      nodes: scanEntry.records,
    };
  }

  return {
    state: {
      schemaVersion: 1,
      treeEventScopeId,
      lastEventId: capturedEventId,
      myFilesRootNodeUid: myFilesRoot.nodeUid,
      mappings: persistedMappings,
      updatedAtIso: new Date().toISOString(),
    },
    snapshotsByRemoteDirectory,
    usedIncrementalEvents: false,
    eventsProcessedCount: 0,
  };
}
