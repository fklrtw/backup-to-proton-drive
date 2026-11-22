import * as path from 'node:path';

import type {
  FileMoveOperation,
  FileUploadOperation,
  LocalFileEntry,
  LocalScanResult,
  RemoteNodeRecord,
  RemoteTreeSnapshot,
  SyncPlan,
} from './types.ts';

/**
 * Options controlling obsolete file and empty directory cleanup during diff planning.
 */
export interface DiffPlanOptions {
  /** Whether remote files absent locally should be scheduled for Trash. */
  trashObsolete: boolean;
  /** Whether obsolete empty remote subdirectories should be scheduled for Trash. */
  deleteEmptyRemoteDirectories: boolean;
}

/**
 * Splits a relative POSIX file path into its parent relative directory (`''` for root)
 * and base filename.
 *
 * @param relativePosixPath - File path relative to the mapping root.
 * @returns Parent relative directory and base filename.
 */
export function splitRelativePosixPath(relativePosixPath: string): {
  parentRelativeDirectory: string;
  fileName: string;
} {
  const dirnameResult = path.posix.dirname(relativePosixPath);
  return {
    parentRelativeDirectory: dirnameResult === '.' ? '' : dirnameResult,
    fileName: path.posix.basename(relativePosixPath),
  };
}

/**
 * Computes the depth (number of path segments) of a relative POSIX directory path.
 *
 * @param relativeDirectoryPath - Relative POSIX path (`''` has depth `0`).
 * @returns Number of `/` segments.
 */
function getRelativeDepth(relativeDirectoryPath: string): number {
  if (!relativeDirectoryPath) {
    return 0;
  }
  return relativeDirectoryPath.split('/').length;
}

/**
 * Adds a relative directory and all of its non-empty ancestor directories to `targetSet`.
 *
 * @param targetSet - Accumulator set of relative POSIX directory paths.
 * @param relativeDirectoryPath - Leaf relative directory path (`''` adds nothing).
 */
function addDirectoryWithAncestors(targetSet: Set<string>, relativeDirectoryPath: string): void {
  if (!relativeDirectoryPath) {
    return;
  }

  const segments = relativeDirectoryPath.split('/');
  for (let segmentCount = 1; segmentCount <= segments.length; segmentCount++) {
    targetSet.add(segments.slice(0, segmentCount).join('/'));
  }
}

/**
 * Computes a deterministic synchronization plan comparing scanned local files against
 * the current remote tree snapshot for one mapping.
 *
 * Key properties:
 * - Pass 1 resolves exact relative-path matches (unchanged vs modified revision upload).
 *   Missing or empty remote SHA1 digests are treated as modified rather than skipped.
 * - Pass 2 pairs unmatched local files 1-to-1 with unmatched remote files having the same
 *   non-empty SHA1 digest to produce zero-bandwidth move/rename operations.
 * - Required missing remote directories are ordered top-down (shallowest first).
 * - When `deleteEmptyRemoteDirectories` is enabled, only top-most empty obsolete folder
 *   subtrees are scheduled for Trash so nested empty folders are trashed in minimal calls.
 *
 * @param localScan - Local filesystem scan output.
 * @param remoteSnapshot - Current remote tree snapshot for the mapping.
 * @param options - Cleanup behavior flags.
 * @returns Complete {@link SyncPlan}.
 */
export function computeSyncPlan(
  localScan: LocalScanResult,
  remoteSnapshot: RemoteTreeSnapshot,
  options: DiffPlanOptions,
): SyncPlan {
  const sortedLocalPaths = Array.from(localScan.filesByRelativePath.keys()).sort();
  const unmatchedLocalFiles: LocalFileEntry[] = [];
  const uploads: FileUploadOperation[] = [];
  const movesAndRenames: FileMoveOperation[] = [];
  const claimedRemoteNodeUids = new Set<string>();
  const survivingFileRelativePaths = new Set<string>();

  let unchangedCount = 0;
  let bytesToTransfer = 0;
  let bytesSavedByMoves = 0;

  // Pass 1: Match local files to remote files at the exact same relative path.
  for (const relativePath of sortedLocalPaths) {
    const localFile = localScan.filesByRelativePath.get(relativePath);
    if (!localFile) {
      continue;
    }

    const remoteNode = remoteSnapshot.filesByRelativePath.get(relativePath);
    if (remoteNode) {
      claimedRemoteNodeUids.add(remoteNode.nodeUid);
      survivingFileRelativePaths.add(relativePath);

      const normalizedRemoteSha1 = remoteNode.sha1Hash ? remoteNode.sha1Hash.toLowerCase() : null;
      if (normalizedRemoteSha1 !== null && normalizedRemoteSha1.length > 0 && normalizedRemoteSha1 === localFile.sha1Hash) {
        unchangedCount++;
      } else {
        const { parentRelativeDirectory, fileName } = splitRelativePosixPath(relativePath);
        uploads.push({
          kind: 'update',
          localFile,
          existingNodeUid: remoteNode.nodeUid,
          targetDirectoryRelativePath: parentRelativeDirectory,
          targetFileName: fileName,
        });
        bytesToTransfer += localFile.sizeInBytes;
      }
    } else {
      unmatchedLocalFiles.push(localFile);
    }
  }

  // Collect unmatched remote files and index those with a valid SHA1 for 1-to-1 move/rename matching.
  const sortedRemotePaths = Array.from(remoteSnapshot.filesByRelativePath.keys()).sort();
  const unmatchedRemoteFiles: RemoteNodeRecord[] = [];
  const unmatchedRemoteCandidatesBySha1 = new Map<string, RemoteNodeRecord[]>();

  for (const remoteRelativePath of sortedRemotePaths) {
    const remoteNode = remoteSnapshot.filesByRelativePath.get(remoteRelativePath);
    if (!remoteNode || claimedRemoteNodeUids.has(remoteNode.nodeUid)) {
      continue;
    }

    unmatchedRemoteFiles.push(remoteNode);

    const normalizedSha1 = remoteNode.sha1Hash ? remoteNode.sha1Hash.toLowerCase() : null;
    if (normalizedSha1 && normalizedSha1.length > 0) {
      const existingCandidates = unmatchedRemoteCandidatesBySha1.get(normalizedSha1) ?? [];
      existingCandidates.push(remoteNode);
      unmatchedRemoteCandidatesBySha1.set(normalizedSha1, existingCandidates);
    }
  }

  // Pass 2: Pair unmatched local files with unclaimed remote files sharing identical SHA1 hashes.
  for (const localFile of unmatchedLocalFiles) {
    const sha1Candidates = unmatchedRemoteCandidatesBySha1.get(localFile.sha1Hash);
    const matchedRemoteNode = sha1Candidates?.shift();
    const { parentRelativeDirectory: targetDirectoryRelativePath, fileName: targetFileName } =
      splitRelativePosixPath(localFile.relativePath);

    survivingFileRelativePaths.add(localFile.relativePath);

    if (matchedRemoteNode) {
      claimedRemoteNodeUids.add(matchedRemoteNode.nodeUid);
      const { parentRelativeDirectory: sourceDirectoryRelativePath, fileName: sourceFileName } =
        splitRelativePosixPath(matchedRemoteNode.relativePath);

      movesAndRenames.push({
        sourceNodeUid: matchedRemoteNode.nodeUid,
        sourceRelativePath: matchedRemoteNode.relativePath,
        targetRelativePath: localFile.relativePath,
        targetDirectoryRelativePath,
        targetFileName,
        needsMove: sourceDirectoryRelativePath !== targetDirectoryRelativePath,
        needsRename: sourceFileName !== targetFileName,
        sizeInBytes: localFile.sizeInBytes,
      });
      bytesSavedByMoves += localFile.sizeInBytes;
    } else {
      uploads.push({
        kind: 'new',
        localFile,
        targetDirectoryRelativePath,
        targetFileName,
      });
      bytesToTransfer += localFile.sizeInBytes;
    }
  }

  // Collect all missing remote subdirectories required for uploads and moves, ordered top-down.
  const requiredDirectories = new Set<string>();
  for (const uploadOperation of uploads) {
    addDirectoryWithAncestors(requiredDirectories, uploadOperation.targetDirectoryRelativePath);
  }
  for (const moveOperation of movesAndRenames) {
    addDirectoryWithAncestors(requiredDirectories, moveOperation.targetDirectoryRelativePath);
  }

  const directoriesToCreate = Array.from(requiredDirectories)
    .filter((relativeDirectory) => !remoteSnapshot.foldersByRelativePath.has(relativeDirectory))
    .sort((firstPath, secondPath) => {
      const depthDifference = getRelativeDepth(firstPath) - getRelativeDepth(secondPath);
      return depthDifference !== 0 ? depthDifference : firstPath.localeCompare(secondPath);
    });

  // Remaining unclaimed remote files are obsolete.
  const obsoleteFileNodes = options.trashObsolete
    ? unmatchedRemoteFiles.filter((remoteNode) => !claimedRemoteNodeUids.has(remoteNode.nodeUid))
    : [];

  // If trashing obsolete files is disabled, all non-trashed remote files continue occupying their folders.
  if (!options.trashObsolete) {
    for (const remoteNode of unmatchedRemoteFiles) {
      survivingFileRelativePaths.add(remoteNode.relativePath);
    }
  }

  let obsoleteEmptyFolderNodes: RemoteNodeRecord[] = [];
  if (options.deleteEmptyRemoteDirectories) {
    const survivingDirectories = new Set<string>();
    for (const survivingFilePath of survivingFileRelativePaths) {
      const { parentRelativeDirectory } = splitRelativePosixPath(survivingFilePath);
      addDirectoryWithAncestors(survivingDirectories, parentRelativeDirectory);
    }

    const emptyObsoleteFolderPaths = new Set<string>();
    for (const [folderRelativePath] of remoteSnapshot.foldersByRelativePath.entries()) {
      // Never delete the mapping's own root directory (`''`).
      if (folderRelativePath === '') {
        continue;
      }
      if (!survivingDirectories.has(folderRelativePath)) {
        emptyObsoleteFolderPaths.add(folderRelativePath);
      }
    }

    // Only keep top-most empty folders whose parent folder is not also obsolete, because
    // trashing an empty parent folder moves its entire empty subtree to Trash at once.
    const topMostObsoleteFolders: RemoteNodeRecord[] = [];
    for (const emptyFolderPath of emptyObsoleteFolderPaths) {
      const { parentRelativeDirectory } = splitRelativePosixPath(emptyFolderPath);
      if (parentRelativeDirectory !== '' && emptyObsoleteFolderPaths.has(parentRelativeDirectory)) {
        continue;
      }
      const folderNode = remoteSnapshot.foldersByRelativePath.get(emptyFolderPath);
      if (folderNode) {
        topMostObsoleteFolders.push(folderNode);
      }
    }

    obsoleteEmptyFolderNodes = topMostObsoleteFolders.sort((firstNode, secondNode) =>
      firstNode.relativePath.localeCompare(secondNode.relativePath),
    );
  }

  return {
    directoriesToCreate,
    movesAndRenames,
    uploads,
    obsoleteFileNodes,
    obsoleteEmptyFolderNodes,
    unchangedCount,
    bytesToTransfer,
    bytesSavedByMoves,
  };
}
