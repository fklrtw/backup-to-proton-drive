import { runWithConcurrency } from './concurrency.ts';
import { computeSyncPlan, splitRelativePosixPath } from './diffEngine.ts';
import { formatBytes } from './format.ts';
import { scanLocalDirectory } from './localScanner.ts';
import {
  buildSnapshotFromNodes,
  loadPersistedRemoteState,
  removeNodeAndDescendantsFromSnapshot,
  savePersistedRemoteState,
  snapshotToDescendantRecords,
  synchronizeRemoteState,
  upsertNodeInSnapshot,
} from './remoteState.ts';
import type {
  ApplicationConfiguration,
  DirectoryMapping,
  FileMoveOperation,
  FileUploadOperation,
  LocalScanResult,
  MappingSyncSummary,
  OverallSyncSummary,
  ProtonDriveAdapter,
  RawRemoteNode,
  RemoteNodeRecord,
  RemoteTreeSnapshot,
  SyncPlan,
} from './types.ts';

/**
 * Parameters accepted by {@link executeSyncRun}.
 */
export interface ExecuteSyncRunOptions {
  /** Adapter interacting with Proton Drive SDK or mock client. */
  adapter: ProtonDriveAdapter;
  /** Parsed application configuration containing mappings and mode flags. */
  configuration: ApplicationConfiguration;
  /** Optional abort signal for clean cancellation on `SIGINT`/`SIGTERM`. */
  abortSignal?: AbortSignal;
  /** Optional logger override (defaults to `console.log`). */
  log?: (message: string) => void;
  /** Optional tabular logger override (defaults to `console.table`). */
  logTable?: (tabularData: unknown) => void;
  /** Optional error logger override (defaults to `console.error`). */
  logError?: (message: string) => void;
}

interface MappingExecutionContext {
  mappingIndex: number;
  mapping: DirectoryMapping;
  localScan: LocalScanResult;
  remoteSnapshot: RemoteTreeSnapshot;
  syncPlan: SyncPlan;
  trashedFilesCount: number;
  trashedEmptyFoldersCount: number;
  failedTrashCount: number;
}

interface TrashTaskItem {
  kind: 'file' | 'folder';
  mappingIndex: number;
  nodeUid: string;
  relativePath: string;
  coveredObsoleteFileCount: number;
}

/**
 * Joins a relative parent directory (`''` for mapping root) and child name using POSIX slashes.
 */
function joinRelativePosixPath(parentRelativeDirectory: string, childName: string): string {
  return parentRelativeDirectory ? `${parentRelativeDirectory}/${childName}` : childName;
}

/**
 * Returns every path touched by a move/rename operation (including intermediate paths when
 * both directory and filename change) so overlapping operations can be serialized safely.
 */
function getTouchedMovePaths(moveOperation: FileMoveOperation): string[] {
  const paths = [moveOperation.sourceRelativePath, moveOperation.targetRelativePath];
  if (moveOperation.needsMove && moveOperation.needsRename) {
    const { parentRelativeDirectory: sourceDirectoryRelativePath, fileName: sourceFileName } =
      splitRelativePosixPath(moveOperation.sourceRelativePath);
    paths.push(joinRelativePosixPath(moveOperation.targetDirectoryRelativePath, sourceFileName));
    paths.push(joinRelativePosixPath(sourceDirectoryRelativePath, moveOperation.targetFileName));
  }
  return paths;
}

/**
 * Partitions a mapping's moves into operations safe to execute concurrently and operations
 * whose touched paths overlap with another move/rename in the same mapping.
 */
function partitionMovesByConflictSafety(
  movesAndRenames: readonly FileMoveOperation[],
): {
  parallelSafeMoves: FileMoveOperation[];
  sequentialMoves: FileMoveOperation[];
} {
  const pathTouchCounts = new Map<string, number>();
  for (const moveOperation of movesAndRenames) {
    const uniquePaths = new Set(getTouchedMovePaths(moveOperation));
    for (const touchedPath of uniquePaths) {
      pathTouchCounts.set(touchedPath, (pathTouchCounts.get(touchedPath) ?? 0) + 1);
    }
  }

  const parallelSafeMoves: FileMoveOperation[] = [];
  const sequentialMoves: FileMoveOperation[] = [];

  for (const moveOperation of movesAndRenames) {
    const touchedPaths = getTouchedMovePaths(moveOperation);
    const hasOverlap = touchedPaths.some((touchedPath) => (pathTouchCounts.get(touchedPath) ?? 0) > 1);
    if (hasOverlap) {
      sequentialMoves.push(moveOperation);
    } else {
      parallelSafeMoves.push(moveOperation);
    }
  }

  return { parallelSafeMoves, sequentialMoves };
}

/**
 * Executes a single move and/or rename operation, selecting a collision-free order when
 * both `needsMove` and `needsRename` are true.
 */
async function executeMoveAndRename(
  adapter: ProtonDriveAdapter,
  snapshot: RemoteTreeSnapshot,
  moveOperation: FileMoveOperation,
  abortSignal?: AbortSignal,
): Promise<void> {
  const targetParentNode = snapshot.foldersByRelativePath.get(moveOperation.targetDirectoryRelativePath);
  if (!targetParentNode) {
    throw new Error(
      `Missing destination folder "${moveOperation.targetDirectoryRelativePath || '/'}" for move target "${moveOperation.targetRelativePath}".`,
    );
  }

  const existingNode = snapshot.nodesByUid.get(moveOperation.sourceNodeUid);
  if (!existingNode) {
    throw new Error(`Missing source node ${moveOperation.sourceNodeUid} in snapshot.`);
  }

  const { parentRelativeDirectory: sourceDirectoryRelativePath, fileName: sourceFileName } =
    splitRelativePosixPath(moveOperation.sourceRelativePath);

  if (moveOperation.needsMove && moveOperation.needsRename) {
    const destinationHasOldName = snapshot.filesByRelativePath.has(
      joinRelativePosixPath(moveOperation.targetDirectoryRelativePath, sourceFileName),
    );
    const sourceHasNewName = snapshot.filesByRelativePath.has(
      joinRelativePosixPath(sourceDirectoryRelativePath, moveOperation.targetFileName),
    );

    if (destinationHasOldName && !sourceHasNewName) {
      await adapter.renameNode(moveOperation.sourceNodeUid, moveOperation.targetFileName);
      await adapter.moveNode(moveOperation.sourceNodeUid, targetParentNode.nodeUid, abortSignal);
    } else {
      await adapter.moveNode(moveOperation.sourceNodeUid, targetParentNode.nodeUid, abortSignal);
      await adapter.renameNode(moveOperation.sourceNodeUid, moveOperation.targetFileName);
    }
  } else if (moveOperation.needsMove) {
    await adapter.moveNode(moveOperation.sourceNodeUid, targetParentNode.nodeUid, abortSignal);
  } else if (moveOperation.needsRename) {
    await adapter.renameNode(moveOperation.sourceNodeUid, moveOperation.targetFileName);
  }

  const updatedRecord: RemoteNodeRecord = {
    ...existingNode,
    parentNodeUid: targetParentNode.nodeUid,
    name: moveOperation.targetFileName,
    relativePath: moveOperation.targetRelativePath,
  };
  upsertNodeInSnapshot(snapshot, updatedRecord);
}

/**
 * Runs a complete one-shot synchronization pass across all configured `L1 -> R1, L2 -> R2, ...`
 * directory mappings using global batched and bounded-concurrency phases:
 *
 * 1. Load all local directories (concurrent streaming SHA1) and remote state/events in parallel.
 * 2. Compute all per-mapping diff plans upfront (and exit early on `--dry-run`).
 * 3. Create missing remote mapping roots (shared single-flight prefix cache) and subdirectories level-by-level.
 * 4. Execute non-conflicting moves and renames concurrently.
 * 5. Execute encrypted file/revision uploads concurrently across all mappings (fail-fast).
 * 6. Execute one consolidated bulk `trashNodes` call across all succeeded mappings (batched by SDK at 100 UIDs).
 *
 * @param options - Execution options, adapter, and configuration.
 * @returns Aggregated summary across all mappings.
 */
export async function executeSyncRun(options: ExecuteSyncRunOptions): Promise<OverallSyncSummary> {
  const {
    adapter,
    configuration,
    abortSignal,
    log = console.log,
    logTable = console.table,
    logError = console.error,
  } = options;

  const overallStartTimeMs = Date.now();
  const modeLabel = configuration.dryRun ? '[DRY RUN] ' : '';
  const logVerbose = (message: string): void => {
    if (configuration.verbose) {
      log(`${modeLabel}[verbose] ${message}`);
    }
  };
  const storageEncryptionOptions = {
    encryptionKey: configuration.dataEncryptionKey,
    allowPlaintext: configuration.allowPlaintextState,
  };

  log(`${modeLabel}Loading cached remote state from ${configuration.stateFilePath}`);
  const existingState = await loadPersistedRemoteState(
    configuration.stateFilePath,
    storageEncryptionOptions,
  );
  logVerbose(
    existingState
      ? `Loaded cached remote state (treeEventScopeId=${existingState.treeEventScopeId}, lastEventId=${existingState.lastEventId}, cachedMappings=${Object.keys(existingState.mappings).length})`
      : 'No cached remote state found on disk; performing cold full scan',
  );
  logVerbose(
    `Starting Phase 1: scanning ${configuration.mappings.length} local directory mapping(s) in parallel with remote state synchronization`,
  );

  // Phase 1: Synchronize remote state and scan/hash all local directories simultaneously.
  const [remoteSyncResult, localScans] = await Promise.all([
    synchronizeRemoteState({
      adapter,
      mappings: configuration.mappings,
      existingState,
      abortSignal,
      remoteScanConcurrency: configuration.remoteScanConcurrency,
    }),
    runWithConcurrency(
      configuration.mappings,
      Math.min(configuration.mappings.length || 1, 4),
      async (mapping) =>
        scanLocalDirectory(
          mapping.localDirectory,
          mapping.excludePatterns,
          abortSignal,
          configuration.localHashConcurrency,
        ),
      abortSignal,
    ),
  ]);

  if (remoteSyncResult.usedIncrementalEvents) {
    log(
      `${modeLabel}Remote state synchronized incrementally (${remoteSyncResult.eventsProcessedCount} event(s) processed)`,
    );
  } else {
    log(`${modeLabel}Remote state indexed via full concurrent directory scan`);
  }
  logVerbose(
    `Phase 1 complete: treeEventScopeId=${remoteSyncResult.state.treeEventScopeId}, capturedEventCursor=${remoteSyncResult.state.lastEventId}`,
  );

  // Phase 2: Compute all diff plans upfront across every mapping.
  const mappingContexts: MappingExecutionContext[] = [];
  const planTableRows: Array<Record<string, string | number>> = [];

  for (let mappingIndex = 0; mappingIndex < configuration.mappings.length; mappingIndex++) {
    const mapping = configuration.mappings[mappingIndex];
    const localScan = localScans[mappingIndex];
    if (!mapping || !localScan) {
      continue;
    }

    abortSignal?.throwIfAborted();

    const remoteSnapshot =
      remoteSyncResult.snapshotsByRemoteDirectory.get(mapping.remoteDirectory) ??
      buildSnapshotFromNodes(null, remoteSyncResult.state.treeEventScopeId, []);
    remoteSyncResult.snapshotsByRemoteDirectory.set(mapping.remoteDirectory, remoteSnapshot);

    const syncPlan = computeSyncPlan(localScan, remoteSnapshot, {
      trashObsolete: mapping.trashObsolete,
      deleteEmptyRemoteDirectories: mapping.deleteEmptyRemoteDirectories,
    });

    const newUploadCount = syncPlan.uploads.filter((uploadItem) => uploadItem.kind === 'new').length;
    const updateUploadCount = syncPlan.uploads.filter((uploadItem) => uploadItem.kind === 'update').length;

    planTableRows.push({
      Local: mapping.localDirectory,
      Remote: mapping.remoteDirectory,
      'Local Files': `${localScan.filesByRelativePath.size} (${formatBytes(localScan.totalSizeInBytes)})`,
      'Remote Files': remoteSnapshot.filesByRelativePath.size,
      New: newUploadCount,
      Updated: updateUploadCount,
      'Moved/Renamed': syncPlan.movesAndRenames.length,
      Unchanged: syncPlan.unchangedCount,
      'Obsolete Files': syncPlan.obsoleteFileNodes.length,
      'Empty Dirs': syncPlan.obsoleteEmptyFolderNodes.length,
      Transfer: formatBytes(syncPlan.bytesToTransfer),
      Saved: formatBytes(syncPlan.bytesSavedByMoves),
    });

    mappingContexts.push({
      mappingIndex,
      mapping,
      localScan,
      remoteSnapshot,
      syncPlan,
      trashedFilesCount: 0,
      trashedEmptyFoldersCount: 0,
      failedTrashCount: 0,
    });
  }

  if (planTableRows.length > 0) {
    log(`${modeLabel}Sync plan (${mappingContexts.length} mapping(s)):`);
    logTable(planTableRows);
  }

  let hasWriteFailures = false;

  if (configuration.dryRun) {
    const dryRunActionRows: Array<{
      Mapping: string;
      Action: string;
      Path: string;
      Size: string;
    }> = [];

    for (const context of mappingContexts) {
      const mappingRemoteDirectory = context.mapping.remoteDirectory;

      for (const relativeDirectory of context.syncPlan.directoriesToCreate) {
        dryRunActionRows.push({
          Mapping: mappingRemoteDirectory,
          Action: 'create folder',
          Path: relativeDirectory,
          Size: '-',
        });
      }
      for (const moveOperation of context.syncPlan.movesAndRenames) {
        dryRunActionRows.push({
          Mapping: mappingRemoteDirectory,
          Action: 'move/rename',
          Path: `${moveOperation.sourceRelativePath} -> ${moveOperation.targetRelativePath}`,
          Size: formatBytes(moveOperation.sizeInBytes),
        });
      }
      for (const uploadOperation of context.syncPlan.uploads) {
        dryRunActionRows.push({
          Mapping: mappingRemoteDirectory,
          Action: `upload (${uploadOperation.kind})`,
          Path: uploadOperation.localFile.relativePath,
          Size: formatBytes(uploadOperation.localFile.sizeInBytes),
        });
      }
      for (const obsoleteFile of context.syncPlan.obsoleteFileNodes) {
        dryRunActionRows.push({
          Mapping: mappingRemoteDirectory,
          Action: 'trash file',
          Path: obsoleteFile.relativePath,
          Size: obsoleteFile.sizeInBytes !== null ? formatBytes(obsoleteFile.sizeInBytes) : '-',
        });
      }
      for (const obsoleteFolder of context.syncPlan.obsoleteEmptyFolderNodes) {
        dryRunActionRows.push({
          Mapping: mappingRemoteDirectory,
          Action: 'trash empty folder',
          Path: obsoleteFolder.relativePath,
          Size: '-',
        });
      }
    }

    if (dryRunActionRows.length > 0) {
      log(`[DRY RUN] Planned actions (${dryRunActionRows.length}):`);
      logTable(dryRunActionRows);
    } else {
      log('[DRY RUN] No remote changes required.');
    }
  } else {
    // Phase 3: Create missing mapping root folders (race-free single-flight shared ancestors)
    // followed by missing subdirectories concurrently per depth wave.
    const contextsNeedingRoot = mappingContexts.filter(
      (context) => context.remoteSnapshot.rootNodeUid === null,
    );

    if (contextsNeedingRoot.length > 0) {
      logVerbose(`Phase 3: resolving/creating ${contextsNeedingRoot.length} missing mapping root path(s)`);
      const myFilesRoot = await adapter.getMyFilesRootFolder();
      const folderPromiseByAbsolutePath = new Map<string, Promise<RawRemoteNode>>();
      folderPromiseByAbsolutePath.set('/', Promise.resolve(myFilesRoot));

      const ensureRemotePathShared = (absoluteRemotePath: string): Promise<RawRemoteNode> => {
        const existingPromise = folderPromiseByAbsolutePath.get(absoluteRemotePath);
        if (existingPromise) {
          return existingPromise;
        }

        const creationPromise = (async () => {
          const lastSlashIndex = absoluteRemotePath.lastIndexOf('/');
          const parentRemotePath = lastSlashIndex <= 0 ? '/' : absoluteRemotePath.slice(0, lastSlashIndex);
          const folderName = absoluteRemotePath.slice(lastSlashIndex + 1);

          const parentFolderNode = await ensureRemotePathShared(parentRemotePath);
          abortSignal?.throwIfAborted();

          const existingChildren = await adapter.listFolderChildren(parentFolderNode.nodeUid, abortSignal);
          const existingMatch = existingChildren.find(
            (childNode) =>
              !childNode.isTrashed && childNode.nodeType === 'folder' && childNode.name === folderName,
          );
          if (existingMatch) {
            logVerbose(`Reused existing remote root segment "${absoluteRemotePath}" -> ${existingMatch.nodeUid}`);
            return existingMatch;
          }

          const createdRootSegment = await adapter.createFolder(parentFolderNode.nodeUid, folderName);
          logVerbose(`Created remote root segment "${absoluteRemotePath}" -> ${createdRootSegment.nodeUid}`);
          return createdRootSegment;
        })();

        folderPromiseByAbsolutePath.set(absoluteRemotePath, creationPromise);
        return creationPromise;
      };

      await runWithConcurrency(
        contextsNeedingRoot,
        configuration.uploadConcurrency,
        async (context) => {
          const ensuredRootNode = await ensureRemotePathShared(context.mapping.remoteDirectory);
          context.remoteSnapshot.rootNodeUid = ensuredRootNode.nodeUid;
          upsertNodeInSnapshot(context.remoteSnapshot, {
            nodeUid: ensuredRootNode.nodeUid,
            parentNodeUid: ensuredRootNode.parentNodeUid,
            name: '',
            nodeType: 'folder',
            relativePath: '',
            sha1Hash: null,
            sizeInBytes: null,
            modificationTimeMs: null,
          });
        },
        abortSignal,
      );
    }

    const subdirectoryEntriesByDepth = new Map<
      number,
      Array<{ context: MappingExecutionContext; relativeDirectory: string }>
    >();
    let maxDirectoryDepth = 0;

    for (const context of mappingContexts) {
      for (const relativeDirectory of context.syncPlan.directoriesToCreate) {
        const depth = relativeDirectory.split('/').length;
        maxDirectoryDepth = Math.max(maxDirectoryDepth, depth);
        const depthBucket = subdirectoryEntriesByDepth.get(depth) ?? [];
        depthBucket.push({ context, relativeDirectory });
        subdirectoryEntriesByDepth.set(depth, depthBucket);
      }
    }

    for (let currentDepth = 1; currentDepth <= maxDirectoryDepth; currentDepth++) {
      const depthEntries = subdirectoryEntriesByDepth.get(currentDepth);
      if (!depthEntries || depthEntries.length === 0) {
        continue;
      }

      logVerbose(`Phase 3 depth ${currentDepth}: creating ${depthEntries.length} remote subfolder(s)`);
      await runWithConcurrency(
        depthEntries,
        configuration.uploadConcurrency,
        async ({ context, relativeDirectory }) => {
          const { parentRelativeDirectory, fileName: folderName } = splitRelativePosixPath(relativeDirectory);
          const parentFolderNode = context.remoteSnapshot.foldersByRelativePath.get(parentRelativeDirectory);
          if (!parentFolderNode) {
            throw new Error(
              `Cannot create remote folder "${relativeDirectory}" because parent "${parentRelativeDirectory || '/'}" is missing.`,
            );
          }

          const createdFolder = await adapter.createFolder(parentFolderNode.nodeUid, folderName);
          logVerbose(
            `Created remote folder "${context.mapping.remoteDirectory === '/' ? '' : context.mapping.remoteDirectory}/${relativeDirectory}" -> ${createdFolder.nodeUid}`,
          );
          upsertNodeInSnapshot(context.remoteSnapshot, {
            nodeUid: createdFolder.nodeUid,
            parentNodeUid: parentFolderNode.nodeUid,
            name: folderName,
            nodeType: 'folder',
            relativePath: relativeDirectory,
            sha1Hash: null,
            sizeInBytes: null,
            modificationTimeMs: createdFolder.modificationTimeMs,
          });
        },
        abortSignal,
      );
    }

    // Phase 4: Execute non-conflicting zero-bandwidth moves/renames concurrently,
    // followed by any overlapping rename/swap chains sequentially.
    const parallelMoveTasks: Array<{ context: MappingExecutionContext; moveOperation: FileMoveOperation }> = [];
    const sequentialMoveLists: Array<{ context: MappingExecutionContext; moves: FileMoveOperation[] }> = [];

    for (const context of mappingContexts) {
      if (context.syncPlan.movesAndRenames.length === 0) {
        continue;
      }
      const partitioned = partitionMovesByConflictSafety(context.syncPlan.movesAndRenames);
      for (const moveOperation of partitioned.parallelSafeMoves) {
        parallelMoveTasks.push({ context, moveOperation });
      }
      if (partitioned.sequentialMoves.length > 0) {
        sequentialMoveLists.push({ context, moves: partitioned.sequentialMoves });
      }
    }

    if (parallelMoveTasks.length > 0 || sequentialMoveLists.length > 0) {
      logVerbose(
        `Phase 4: executing ${parallelMoveTasks.length} parallel move/rename(s) and ${sequentialMoveLists.length} sequential conflict group(s)`,
      );
    }

    if (parallelMoveTasks.length > 0) {
      await runWithConcurrency(
        parallelMoveTasks,
        configuration.uploadConcurrency,
        async ({ context, moveOperation }) => {
          log(`Moving/renaming ${moveOperation.sourceRelativePath} -> ${moveOperation.targetRelativePath}`);
          await executeMoveAndRename(adapter, context.remoteSnapshot, moveOperation, abortSignal);
        },
        abortSignal,
      );
    }

    for (const sequentialGroup of sequentialMoveLists) {
      for (const moveOperation of sequentialGroup.moves) {
        abortSignal?.throwIfAborted();
        log(`Moving/renaming ${moveOperation.sourceRelativePath} -> ${moveOperation.targetRelativePath}`);
        await executeMoveAndRename(
          adapter,
          sequentialGroup.context.remoteSnapshot,
          moveOperation,
          abortSignal,
        );
      }
    }

    // Phase 5: Stream and encrypt all file/revision uploads across all mappings using a single
    // bounded concurrent worker pool (fail-fast: skip trashing if any upload fails).
    const allUploadTasks: Array<{ context: MappingExecutionContext; uploadOperation: FileUploadOperation }> = [];
    let totalUploadNewCount = 0;
    let totalUploadUpdateCount = 0;
    let totalBytesQueued = 0;

    for (const context of mappingContexts) {
      for (const uploadOperation of context.syncPlan.uploads) {
        allUploadTasks.push({ context, uploadOperation });
        totalBytesQueued += uploadOperation.localFile.sizeInBytes;
        if (uploadOperation.kind === 'new') {
          totalUploadNewCount++;
        } else {
          totalUploadUpdateCount++;
        }
      }
    }

    if (allUploadTasks.length > 0) {
      log(
        `Uploading ${allUploadTasks.length} file(s) (${totalUploadNewCount} new, ${totalUploadUpdateCount} updated, ${formatBytes(totalBytesQueued)}) with concurrency ${configuration.uploadConcurrency}...`,
      );

      await runWithConcurrency(
        allUploadTasks,
        configuration.uploadConcurrency,
        async ({ context, uploadOperation }) => {
          const localFile = uploadOperation.localFile;
          logVerbose(
            `Uploading (${uploadOperation.kind}): ${localFile.relativePath} (${formatBytes(localFile.sizeInBytes)}, sha1=${localFile.sha1Hash.slice(0, 8)}...)`,
          );

          if (uploadOperation.kind === 'new') {
            const parentFolderNode = context.remoteSnapshot.foldersByRelativePath.get(
              uploadOperation.targetDirectoryRelativePath,
            );
            if (!parentFolderNode) {
              throw new Error(
                `Missing remote parent folder "${uploadOperation.targetDirectoryRelativePath || '/'}" for "${localFile.relativePath}".`,
              );
            }

            const uploadResult = await adapter.uploadNewFile(parentFolderNode.nodeUid, localFile, abortSignal);
            logVerbose(`Uploaded ${localFile.relativePath} -> nodeUid=${uploadResult.nodeUid}`);
            upsertNodeInSnapshot(context.remoteSnapshot, {
              nodeUid: uploadResult.nodeUid,
              parentNodeUid: parentFolderNode.nodeUid,
              name: uploadOperation.targetFileName,
              nodeType: 'file',
              relativePath: localFile.relativePath,
              sha1Hash: localFile.sha1Hash,
              sizeInBytes: localFile.sizeInBytes,
              modificationTimeMs: localFile.modificationTime.getTime(),
            });
          } else {
            const existingRecord = context.remoteSnapshot.nodesByUid.get(uploadOperation.existingNodeUid);
            const parentNodeUid = existingRecord?.parentNodeUid ?? null;
            const uploadResult = await adapter.uploadFileRevision(
              uploadOperation.existingNodeUid,
              localFile,
              abortSignal,
            );
            logVerbose(
              `Uploaded new revision for ${localFile.relativePath} -> nodeUid=${uploadResult.nodeUid}, revisionUid=${uploadResult.revisionUid}`,
            );

            upsertNodeInSnapshot(context.remoteSnapshot, {
              nodeUid: uploadResult.nodeUid,
              parentNodeUid,
              name: uploadOperation.targetFileName,
              nodeType: 'file',
              relativePath: localFile.relativePath,
              sha1Hash: localFile.sha1Hash,
              sizeInBytes: localFile.sizeInBytes,
              modificationTimeMs: localFile.modificationTime.getTime(),
            });
          }
        },
        abortSignal,
      );
    }

    // Phase 6: Consolidated bulk trash across all mappings (batched by SDK at 100 UIDs/request).
    // Omit obsolete child files that are already inside a top-most obsolete empty folder being trashed.
    const allTrashTasks: TrashTaskItem[] = [];
    const taskByUid = new Map<string, TrashTaskItem>();

    for (const context of mappingContexts) {
      const emptyFolderPrefixes = context.syncPlan.obsoleteEmptyFolderNodes.map((folderNode) => ({
        folderNode,
        prefix: `${folderNode.relativePath}/`,
        coveredCount: 0,
      }));

      for (const obsoleteFile of context.syncPlan.obsoleteFileNodes) {
        const coveringFolder = emptyFolderPrefixes.find((entry) =>
          obsoleteFile.relativePath.startsWith(entry.prefix),
        );
        if (coveringFolder) {
          coveringFolder.coveredCount += 1;
          continue;
        }

        const fileTask: TrashTaskItem = {
          kind: 'file',
          mappingIndex: context.mappingIndex,
          nodeUid: obsoleteFile.nodeUid,
          relativePath: obsoleteFile.relativePath,
          coveredObsoleteFileCount: 0,
        };
        allTrashTasks.push(fileTask);
        taskByUid.set(fileTask.nodeUid, fileTask);
      }

      for (const folderEntry of emptyFolderPrefixes) {
        const folderTask: TrashTaskItem = {
          kind: 'folder',
          mappingIndex: context.mappingIndex,
          nodeUid: folderEntry.folderNode.nodeUid,
          relativePath: folderEntry.folderNode.relativePath,
          coveredObsoleteFileCount: folderEntry.coveredCount,
        };
        allTrashTasks.push(folderTask);
        taskByUid.set(folderTask.nodeUid, folderTask);
      }
    }

    if (allTrashTasks.length > 0) {
      for (const trashTask of allTrashTasks) {
        logVerbose(`Trash queued (${trashTask.kind}): ${trashTask.relativePath} (uid=${trashTask.nodeUid})`);
      }
      log(`Trashing ${allTrashTasks.length} obsolete item(s) in bulk...`);
      const batchResults = await adapter.trashNodes(
        allTrashTasks.map((trashTask) => trashTask.nodeUid),
        abortSignal,
      );

      for (const trashResult of batchResults) {
        const matchedTask = taskByUid.get(trashResult.nodeUid);
        if (!matchedTask) {
          continue;
        }
        const context = mappingContexts[matchedTask.mappingIndex];
        if (!context) {
          continue;
        }

        if (trashResult.succeeded) {
          removeNodeAndDescendantsFromSnapshot(context.remoteSnapshot, trashResult.nodeUid);
          if (matchedTask.kind === 'folder') {
            context.trashedEmptyFoldersCount += 1;
            context.trashedFilesCount += matchedTask.coveredObsoleteFileCount;
          } else {
            context.trashedFilesCount += 1;
          }
        } else {
          context.failedTrashCount += 1;
          hasWriteFailures = true;
          logError(
            `Failed to trash ${matchedTask.kind} ${matchedTask.relativePath}: ${trashResult.errorMessage ?? 'Unknown error'}`,
          );
        }
      }
    }

    for (const context of mappingContexts) {
      remoteSyncResult.state.mappings[context.mapping.remoteDirectory] = {
        remoteDirectory: context.mapping.remoteDirectory,
        rootNodeUid: context.remoteSnapshot.rootNodeUid,
        nodes: snapshotToDescendantRecords(context.remoteSnapshot),
      };
    }

    if (hasWriteFailures) {
      logError('One or more non-fatal trash operations failed during sync.');
    }
    remoteSyncResult.state.updatedAtIso = new Date().toISOString();
    await savePersistedRemoteState(
      configuration.stateFilePath,
      remoteSyncResult.state,
      storageEncryptionOptions,
    );
    logVerbose(
      `Persisted state cache to ${configuration.stateFilePath} (encryption=${configuration.dataEncryptionKey ? 'AES-256-GCM' : 'plaintext'}, lastEventId=${remoteSyncResult.state.lastEventId})`,
    );
  }

  const totalDurationSeconds = Number(((Date.now() - overallStartTimeMs) / 1000).toFixed(2));

  const mappingSummaries: MappingSyncSummary[] = [];
  let totalNewFilesCount = 0;
  let totalUpdatedFilesCount = 0;
  let totalMovedOrRenamedFilesCount = 0;
  let totalUnchangedFilesCount = 0;
  let totalTrashedFilesCount = 0;
  let totalTrashedEmptyFoldersCount = 0;
  let totalFailedTrashCount = 0;
  let totalBytesTransferred = 0;
  let totalBytesSavedByMoves = 0;

  for (const context of mappingContexts) {
    const newFilesCount = context.syncPlan.uploads.filter((item) => item.kind === 'new').length;
    const updatedFilesCount = context.syncPlan.uploads.filter((item) => item.kind === 'update').length;

    const summary: MappingSyncSummary = {
      localDirectory: context.mapping.localDirectory,
      remoteDirectory: context.mapping.remoteDirectory,
      newFilesCount,
      updatedFilesCount,
      movedOrRenamedFilesCount: context.syncPlan.movesAndRenames.length,
      unchangedFilesCount: context.syncPlan.unchangedCount,
      trashedFilesCount: context.trashedFilesCount,
      trashedEmptyFoldersCount: context.trashedEmptyFoldersCount,
      failedTrashCount: context.failedTrashCount,
      bytesTransferred: context.syncPlan.bytesToTransfer,
      bytesSavedByMoves: context.syncPlan.bytesSavedByMoves,
      durationSeconds: totalDurationSeconds,
    };
    mappingSummaries.push(summary);

    totalNewFilesCount += summary.newFilesCount;
    totalUpdatedFilesCount += summary.updatedFilesCount;
    totalMovedOrRenamedFilesCount += summary.movedOrRenamedFilesCount;
    totalUnchangedFilesCount += summary.unchangedFilesCount;
    totalTrashedFilesCount += summary.trashedFilesCount;
    totalTrashedEmptyFoldersCount += summary.trashedEmptyFoldersCount;
    totalFailedTrashCount += summary.failedTrashCount;
    totalBytesTransferred += summary.bytesTransferred;
    totalBytesSavedByMoves += summary.bytesSavedByMoves;
  }

  const summaryTableRows: Array<Record<string, string | number>> = mappingSummaries.map((summary) => ({
    Mapping: summary.remoteDirectory,
    New: summary.newFilesCount,
    Updated: summary.updatedFilesCount,
    'Moved/Renamed': summary.movedOrRenamedFilesCount,
    Unchanged: summary.unchangedFilesCount,
    Trashed: summary.trashedFilesCount,
    'Empty Dirs': summary.trashedEmptyFoldersCount,
    'Trash Failed': summary.failedTrashCount,
    Transferred: formatBytes(summary.bytesTransferred),
    Saved: formatBytes(summary.bytesSavedByMoves),
  }));

  if (mappingSummaries.length > 1) {
    summaryTableRows.push({
      Mapping: 'TOTAL',
      New: totalNewFilesCount,
      Updated: totalUpdatedFilesCount,
      'Moved/Renamed': totalMovedOrRenamedFilesCount,
      Unchanged: totalUnchangedFilesCount,
      Trashed: totalTrashedFilesCount,
      'Empty Dirs': totalTrashedEmptyFoldersCount,
      'Trash Failed': totalFailedTrashCount,
      Transferred: formatBytes(totalBytesTransferred),
      Saved: formatBytes(totalBytesSavedByMoves),
    });
  }

  log(`${modeLabel}Done in ${totalDurationSeconds.toFixed(2)}s:`);
  if (summaryTableRows.length > 0) {
    logTable(summaryTableRows);
  }

  return {
    dryRun: configuration.dryRun,
    usedIncrementalEvents: remoteSyncResult.usedIncrementalEvents,
    eventsProcessedCount: remoteSyncResult.eventsProcessedCount,
    mappingSummaries,
    totalNewFilesCount,
    totalUpdatedFilesCount,
    totalMovedOrRenamedFilesCount,
    totalUnchangedFilesCount,
    totalTrashedFilesCount,
    totalTrashedEmptyFoldersCount,
    totalFailedTrashCount,
    totalBytesTransferred,
    totalBytesSavedByMoves,
    totalDurationSeconds,
  };
}
