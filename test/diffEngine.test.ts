import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computeSyncPlan } from '../src/diffEngine.ts';
import { buildSnapshotFromNodes } from '../src/remoteState.ts';
import type { LocalFileEntry, LocalScanResult, RemoteNodeRecord } from '../src/types.ts';

/**
 * Creates a deterministic local file entry for diff tests.
 */
function makeLocalFile(
  relativePath: string,
  sha1Hash: string,
  sizeInBytes = 100,
): LocalFileEntry {
  return {
    absolutePath: `/local/${relativePath}`,
    relativePath,
    sha1Hash,
    sizeInBytes,
    modificationTime: new Date('2026-01-01T00:00:00.000Z'),
  };
}

/**
 * Builds a {@link LocalScanResult} from a list of entries.
 */
function makeLocalScan(entries: readonly LocalFileEntry[]): LocalScanResult {
  const filesByRelativePath = new Map<string, LocalFileEntry>();
  let totalSizeInBytes = 0;

  for (const entry of entries) {
    filesByRelativePath.set(entry.relativePath, entry);
    totalSizeInBytes += entry.sizeInBytes;
  }

  return {
    filesByRelativePath,
    totalSizeInBytes,
  };
}

/**
 * Creates a deterministic remote node record for diff tests.
 */
function makeRemoteRecord(options: {
  nodeUid: string;
  parentNodeUid: string | null;
  relativePath: string;
  nodeType: 'file' | 'folder';
  sha1Hash?: string | null;
  sizeInBytes?: number | null;
}): RemoteNodeRecord {
  const segments = options.relativePath.split('/');
  const name = segments[segments.length - 1] ?? '';
  return {
    nodeUid: options.nodeUid,
    parentNodeUid: options.parentNodeUid,
    name,
    nodeType: options.nodeType,
    relativePath: options.relativePath,
    sha1Hash: options.sha1Hash ?? null,
    sizeInBytes: options.sizeInBytes ?? null,
    modificationTimeMs: 1_700_000_000_000,
  };
}

describe('diffEngine (computeSyncPlan)', () => {
  it('identifies new, unchanged (case-insensitive SHA1), modified, and empty-SHA1 files', () => {
    const localScan = makeLocalScan([
      makeLocalFile('same.txt', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 10),
      makeLocalFile('modified.txt', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 20),
      makeLocalFile('missing-remote-sha.txt', 'cccccccccccccccccccccccccccccccccccccccc', 30),
      makeLocalFile('nested/brand-new.txt', 'dddddddddddddddddddddddddddddddddddddddd', 40),
    ]);

    const snapshot = buildSnapshotFromNodes('root-uid', 'vol-1', [
      makeRemoteRecord({
        nodeUid: 'node-same',
        parentNodeUid: 'root-uid',
        relativePath: 'same.txt',
        nodeType: 'file',
        sha1Hash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      }),
      makeRemoteRecord({
        nodeUid: 'node-modified',
        parentNodeUid: 'root-uid',
        relativePath: 'modified.txt',
        nodeType: 'file',
        sha1Hash: '1111111111111111111111111111111111111111',
      }),
      makeRemoteRecord({
        nodeUid: 'node-empty-sha',
        parentNodeUid: 'root-uid',
        relativePath: 'missing-remote-sha.txt',
        nodeType: 'file',
        sha1Hash: '',
      }),
    ]);

    const plan = computeSyncPlan(localScan, snapshot, {
      trashObsolete: true,
      deleteEmptyRemoteDirectories: false,
    });

    assert.equal(plan.unchangedCount, 1);
    assert.deepEqual(plan.directoriesToCreate, ['nested']);
    assert.equal(plan.movesAndRenames.length, 0);
    assert.equal(plan.uploads.length, 3);
    assert.deepEqual(
      plan.uploads.map((uploadItem) => ({
        kind: uploadItem.kind,
        relativePath: uploadItem.localFile.relativePath,
      })),
      [
        { kind: 'update', relativePath: 'missing-remote-sha.txt' },
        { kind: 'update', relativePath: 'modified.txt' },
        { kind: 'new', relativePath: 'nested/brand-new.txt' },
      ],
    );
    assert.equal(plan.bytesToTransfer, 20 + 30 + 40);
  });

  it('detects in-place renames, cross-folder moves, simultaneous move+renames, and 1-to-1 SHA1 duplicates', () => {
    const sharedHash = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

    const localScan = makeLocalScan([
      makeLocalFile('renamed.txt', '1111111111111111111111111111111111111111', 100),
      makeLocalFile('archive/moved.txt', '2222222222222222222222222222222222222222', 200),
      makeLocalFile('deep/target/both.txt', '3333333333333333333333333333333333333333', 300),
      makeLocalFile('dup-one.txt', sharedHash, 50),
      makeLocalFile('dup-two.txt', sharedHash, 50),
    ]);

    const snapshot = buildSnapshotFromNodes('root-uid', 'vol-1', [
      makeRemoteRecord({
        nodeUid: 'folder-archive',
        parentNodeUid: 'root-uid',
        relativePath: 'archive',
        nodeType: 'folder',
      }),
      makeRemoteRecord({
        nodeUid: 'node-rename',
        parentNodeUid: 'root-uid',
        relativePath: 'original.txt',
        nodeType: 'file',
        sha1Hash: '1111111111111111111111111111111111111111',
      }),
      makeRemoteRecord({
        nodeUid: 'node-move',
        parentNodeUid: 'root-uid',
        relativePath: 'moved.txt',
        nodeType: 'file',
        sha1Hash: '2222222222222222222222222222222222222222',
      }),
      makeRemoteRecord({
        nodeUid: 'node-both',
        parentNodeUid: 'root-uid',
        relativePath: 'before.txt',
        nodeType: 'file',
        sha1Hash: '3333333333333333333333333333333333333333',
      }),
      makeRemoteRecord({
        nodeUid: 'node-dup',
        parentNodeUid: 'root-uid',
        relativePath: 'old-dup.txt',
        nodeType: 'file',
        sha1Hash: sharedHash,
      }),
    ]);

    const plan = computeSyncPlan(localScan, snapshot, {
      trashObsolete: true,
      deleteEmptyRemoteDirectories: false,
    });

    assert.deepEqual(plan.directoriesToCreate, ['deep', 'deep/target']);
    assert.equal(plan.movesAndRenames.length, 4);
    assert.equal(plan.bytesSavedByMoves, 100 + 200 + 300 + 50);

    const renameOperation = plan.movesAndRenames.find(
      (operation) => operation.sourceNodeUid === 'node-rename',
    );
    assert.deepEqual(renameOperation, {
      sourceNodeUid: 'node-rename',
      sourceRelativePath: 'original.txt',
      targetRelativePath: 'renamed.txt',
      targetDirectoryRelativePath: '',
      targetFileName: 'renamed.txt',
      needsMove: false,
      needsRename: true,
      sizeInBytes: 100,
    });

    const moveOperation = plan.movesAndRenames.find(
      (operation) => operation.sourceNodeUid === 'node-move',
    );
    assert.equal(moveOperation?.needsMove, true);
    assert.equal(moveOperation?.needsRename, false);

    const bothOperation = plan.movesAndRenames.find(
      (operation) => operation.sourceNodeUid === 'node-both',
    );
    assert.equal(bothOperation?.needsMove, true);
    assert.equal(bothOperation?.needsRename, true);

    // Only one duplicate matches 1-to-1; the second copy must be uploaded cleanly as new.
    assert.equal(plan.uploads.length, 1);
    assert.equal(plan.uploads[0]?.kind, 'new');
    assert.equal(plan.uploads[0]?.localFile.relativePath, 'dup-two.txt');
    assert.equal(plan.obsoleteFileNodes.length, 0);
  });

  it('schedules obsolete file trashing and top-most empty directory cleanup appropriately', () => {
    const localScan = makeLocalScan([
      makeLocalFile('keep-dir/alive.txt', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 10),
    ]);

    const snapshot = buildSnapshotFromNodes('root-uid', 'vol-1', [
      makeRemoteRecord({
        nodeUid: 'folder-keep',
        parentNodeUid: 'root-uid',
        relativePath: 'keep-dir',
        nodeType: 'folder',
      }),
      makeRemoteRecord({
        nodeUid: 'file-alive',
        parentNodeUid: 'folder-keep',
        relativePath: 'keep-dir/alive.txt',
        nodeType: 'file',
        sha1Hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
      makeRemoteRecord({
        nodeUid: 'folder-empty-parent',
        parentNodeUid: 'root-uid',
        relativePath: 'old-tree',
        nodeType: 'folder',
      }),
      makeRemoteRecord({
        nodeUid: 'folder-empty-child',
        parentNodeUid: 'folder-empty-parent',
        relativePath: 'old-tree/nested',
        nodeType: 'folder',
      }),
      makeRemoteRecord({
        nodeUid: 'file-obsolete',
        parentNodeUid: 'folder-empty-child',
        relativePath: 'old-tree/nested/stale.txt',
        nodeType: 'file',
        sha1Hash: 'ffffffffffffffffffffffffffffffffffffffff',
      }),
    ]);

    const cleanupPlan = computeSyncPlan(localScan, snapshot, {
      trashObsolete: true,
      deleteEmptyRemoteDirectories: true,
    });
    assert.deepEqual(
      cleanupPlan.obsoleteFileNodes.map((node) => node.relativePath),
      ['old-tree/nested/stale.txt'],
    );
    // Because both `old-tree` and `old-tree/nested` become empty, only top-most `old-tree` is scheduled.
    assert.deepEqual(
      cleanupPlan.obsoleteEmptyFolderNodes.map((node) => node.relativePath),
      ['old-tree'],
    );

    // When trashing obsolete files is disabled, `old-tree/nested/stale.txt` still occupies `old-tree`.
    const keepObsoletePlan = computeSyncPlan(localScan, snapshot, {
      trashObsolete: false,
      deleteEmptyRemoteDirectories: true,
    });
    assert.equal(keepObsoletePlan.obsoleteFileNodes.length, 0);
    assert.equal(keepObsoletePlan.obsoleteEmptyFolderNodes.length, 0);
  });
});
