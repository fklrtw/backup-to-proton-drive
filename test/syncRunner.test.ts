import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { parseApplicationConfiguration } from '../src/config.ts';
import { loadPersistedRemoteState } from '../src/remoteState.ts';
import { executeSyncRun } from '../src/syncRunner.ts';
import type {
  DriveTreeEvent,
  LocalFileEntry,
  ProtonDriveAdapter,
  RawRemoteNode,
} from '../src/types.ts';

/**
 * Full stateful in-memory mock of {@link ProtonDriveAdapter} simulating folder creation,
 * streaming uploads/revisions, moves, renames, batched trashing, and event tracking.
 */
function createStatefulDriveMock(
  initialNodes: readonly RawRemoteNode[],
  initialHeadEventId = 'evt-1',
  delayOptions: {
    uploadDelayMs?: number;
    folderCreateDelayMs?: number;
  } = {},
) {
  const nodesByUid = new Map<string, RawRemoteNode>();
  for (const node of initialNodes) {
    nodesByUid.set(node.nodeUid, { ...node });
  }

  let nextGeneratedId = 1;
  let failNextUpload = false;
  let failTrashForUid: string | null = null;
  let activeUploads = 0;
  let peakActiveUploads = 0;
  let activeFolderCreates = 0;
  let peakActiveFolderCreates = 0;

  const operationsLog: string[] = [];

  const adapter: ProtonDriveAdapter = {
    async getMyFilesRootFolder(): Promise<RawRemoteNode> {
      const rootNode = nodesByUid.get('root-uid');
      if (!rootNode) {
        throw new Error('Root node not initialized');
      }
      return { ...rootNode };
    },

    async listFolderChildren(parentNodeUid: string): Promise<RawRemoteNode[]> {
      return Array.from(nodesByUid.values())
        .filter((node) => node.parentNodeUid === parentNodeUid && !node.isTrashed)
        .map((node) => ({ ...node }));
    },

    async getNodesByUids(nodeUids: string[]): Promise<Map<string, RawRemoteNode | null>> {
      const results = new Map<string, RawRemoteNode | null>();
      for (const nodeUid of nodeUids) {
        const node = nodesByUid.get(nodeUid);
        results.set(nodeUid, node ? { ...node } : null);
      }
      return results;
    },

    async getNodeHierarchy(nodeUid: string): Promise<RawRemoteNode[]> {
      const hierarchy: RawRemoteNode[] = [];
      let currentUid: string | null = nodeUid;
      while (currentUid) {
        const node = nodesByUid.get(currentUid);
        if (!node) {
          break;
        }
        hierarchy.unshift({ ...node });
        currentUid = node.parentNodeUid;
      }
      return hierarchy;
    },

    async getLatestEventId(): Promise<string> {
      return initialHeadEventId;
    },

    async *iterateEvents(): AsyncIterable<DriveTreeEvent> {
      // No external remote events occurred during this test sequence.
    },

    async createFolder(parentNodeUid: string, folderName: string): Promise<RawRemoteNode> {
      activeFolderCreates++;
      peakActiveFolderCreates = Math.max(peakActiveFolderCreates, activeFolderCreates);
      try {
        if (delayOptions.folderCreateDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, delayOptions.folderCreateDelayMs));
        }
        // Guard against duplicate sibling creation races.
        const duplicateSibling = Array.from(nodesByUid.values()).find(
          (node) => !node.isTrashed && node.parentNodeUid === parentNodeUid && node.name === folderName,
        );
        if (duplicateSibling) {
          throw new Error(`Duplicate folder creation race for "${folderName}" under ${parentNodeUid}`);
        }
        const newUid = `created-folder-${nextGeneratedId++}`;
        const created: RawRemoteNode = {
          nodeUid: newUid,
          parentNodeUid,
          name: folderName,
          nodeType: 'folder',
          treeEventScopeId: 'vol-1',
          isTrashed: false,
          sha1Hash: null,
          sizeInBytes: null,
          modificationTimeMs: Date.now(),
        };
        nodesByUid.set(newUid, created);
        operationsLog.push(`createFolder:${parentNodeUid}:${folderName}`);
        return { ...created };
      } finally {
        activeFolderCreates--;
      }
    },

    async uploadNewFile(
      parentNodeUid: string,
      localFile: LocalFileEntry,
    ): Promise<{ nodeUid: string; revisionUid: string }> {
      activeUploads++;
      peakActiveUploads = Math.max(peakActiveUploads, activeUploads);
      try {
        if (delayOptions.uploadDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, delayOptions.uploadDelayMs));
        }
        if (failNextUpload) {
          throw new Error('Simulated upload failure');
        }
        const newUid = `uploaded-file-${nextGeneratedId++}`;
        const fileName = localFile.relativePath.split('/').pop() ?? localFile.relativePath;
        nodesByUid.set(newUid, {
          nodeUid: newUid,
          parentNodeUid,
          name: fileName,
          nodeType: 'file',
          treeEventScopeId: 'vol-1',
          isTrashed: false,
          sha1Hash: localFile.sha1Hash,
          sizeInBytes: localFile.sizeInBytes,
          modificationTimeMs: localFile.modificationTime.getTime(),
        });
        operationsLog.push(`uploadNew:${parentNodeUid}:${localFile.relativePath}`);
        return { nodeUid: newUid, revisionUid: `${newUid}-rev-2` };
      } finally {
        activeUploads--;
      }
    },

    async uploadFileRevision(
      existingNodeUid: string,
      localFile: LocalFileEntry,
    ): Promise<{ nodeUid: string; revisionUid: string }> {
      activeUploads++;
      peakActiveUploads = Math.max(peakActiveUploads, activeUploads);
      try {
        if (delayOptions.uploadDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, delayOptions.uploadDelayMs));
        }
        if (failNextUpload) {
          throw new Error('Simulated revision upload failure');
        }
        const existing = nodesByUid.get(existingNodeUid);
        if (!existing) {
          throw new Error(`Missing node ${existingNodeUid}`);
        }
        existing.sha1Hash = localFile.sha1Hash;
        existing.sizeInBytes = localFile.sizeInBytes;
        operationsLog.push(`uploadRevision:${existingNodeUid}:${localFile.relativePath}`);
        return { nodeUid: existingNodeUid, revisionUid: `${existingNodeUid}-rev-new` };
      } finally {
        activeUploads--;
      }
    },

    async renameNode(nodeUid: string, newName: string): Promise<RawRemoteNode> {
      const existing = nodesByUid.get(nodeUid);
      if (!existing) {
        throw new Error(`Missing node ${nodeUid}`);
      }
      existing.name = newName;
      operationsLog.push(`rename:${nodeUid}:${newName}`);
      return { ...existing };
    },

    async moveNode(nodeUid: string, newParentNodeUid: string): Promise<void> {
      const existing = nodesByUid.get(nodeUid);
      if (!existing) {
        throw new Error(`Missing node ${nodeUid}`);
      }
      existing.parentNodeUid = newParentNodeUid;
      operationsLog.push(`move:${nodeUid}:${newParentNodeUid}`);
    },

    async trashNodes(nodeUids: string[]) {
      operationsLog.push(`trash:${nodeUids.join(',')}`);
      return nodeUids.map((nodeUid) => {
        if (failTrashForUid === nodeUid) {
          return { nodeUid, succeeded: false, errorMessage: 'Simulated trash rejection' };
        }
        const existing = nodesByUid.get(nodeUid);
        if (existing) {
          existing.isTrashed = true;
        }
        return { nodeUid, succeeded: true };
      });
    },
  };

  return {
    adapter,
    nodesByUid,
    operationsLog,
    getPeakActiveUploads: () => peakActiveUploads,
    getPeakActiveFolderCreates: () => peakActiveFolderCreates,
    setFailNextUpload: (value: boolean) => {
      failNextUpload = value;
    },
    setFailTrashForUid: (nodeUid: string | null) => {
      failTrashForUid = nodeUid;
    },
  };
}

describe('syncRunner', () => {
  let temporaryRoot = '';
  let localOne = '';
  let localTwo = '';
  let stateFilePath = '';
  let sessionFilePath = '';
  let encryptionKeyFilePath = '';
  let masterEncryptionKey = Buffer.alloc(0);

  before(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'proton-backup-runner-test-'));
    localOne = path.join(temporaryRoot, 'local-one');
    localTwo = path.join(temporaryRoot, 'local-two');
    stateFilePath = path.join(temporaryRoot, 'data', 'state.json');
    sessionFilePath = path.join(temporaryRoot, 'data', 'session.json');
    encryptionKeyFilePath = path.join(temporaryRoot, 'data', 'encryption.key');

    fs.mkdirSync(path.join(localOne, 'sub'), { recursive: true });
    fs.mkdirSync(localTwo, { recursive: true });
    fs.mkdirSync(path.dirname(encryptionKeyFilePath), { recursive: true });

    const keyString = 'sync-runner-test-encryption-key-at-least-32-bytes';
    masterEncryptionKey = Buffer.from(keyString, 'utf8');
    fs.writeFileSync(encryptionKeyFilePath, `${keyString}\n`, 'utf8');

    fs.writeFileSync(path.join(localOne, 'unchanged.txt'), 'unchanged content', 'utf8');
    fs.writeFileSync(path.join(localOne, 'updated.txt'), 'new version content', 'utf8');
    fs.writeFileSync(path.join(localOne, 'sub', 'relocated.txt'), 'moved payload', 'utf8');
    fs.writeFileSync(path.join(localTwo, 'second-root.txt'), 'mapping two file', 'utf8');
  });

  after(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it('performs dry-run across multiple mappings without mutating remote state or writing stateFile', async () => {
    const unchangedSha1 = crypto.createHash('sha1').update('unchanged content').digest('hex');
    const movedSha1 = crypto.createHash('sha1').update('moved payload').digest('hex');

    const mock = createStatefulDriveMock([
      {
        nodeUid: 'root-uid',
        parentNodeUid: null,
        name: 'My files',
        nodeType: 'folder',
        treeEventScopeId: 'vol-1',
        isTrashed: false,
        sha1Hash: null,
        sizeInBytes: null,
        modificationTimeMs: 1000,
      },
      {
        nodeUid: 'r1-uid',
        parentNodeUid: 'root-uid',
        name: 'One',
        nodeType: 'folder',
        treeEventScopeId: 'vol-1',
        isTrashed: false,
        sha1Hash: null,
        sizeInBytes: null,
        modificationTimeMs: 1000,
      },
      {
        nodeUid: 'file-unchanged',
        parentNodeUid: 'r1-uid',
        name: 'unchanged.txt',
        nodeType: 'file',
        treeEventScopeId: 'vol-1',
        isTrashed: false,
        sha1Hash: unchangedSha1,
        sizeInBytes: 17,
        modificationTimeMs: 1000,
      },
      {
        nodeUid: 'file-relocated',
        parentNodeUid: 'r1-uid',
        name: 'old-name.txt',
        nodeType: 'file',
        treeEventScopeId: 'vol-1',
        isTrashed: false,
        sha1Hash: movedSha1,
        sizeInBytes: 13,
        modificationTimeMs: 1000,
      },
      {
        nodeUid: 'file-obsolete',
        parentNodeUid: 'r1-uid',
        name: 'obsolete.txt',
        nodeType: 'file',
        treeEventScopeId: 'vol-1',
        isTrashed: false,
        sha1Hash: '9999999999999999999999999999999999999999',
        sizeInBytes: 5,
        modificationTimeMs: 1000,
      },
    ]);

    const configuration = parseApplicationConfiguration({
      argv: [
        '--map',
        `${localOne}:/One`,
        '--map',
        `${localTwo}:/Backups/Two`,
        '--dry-run',
        '--state-file',
        stateFilePath,
        '--session-file',
        sessionFilePath,
        '--encryption-key-file',
        encryptionKeyFilePath,
      ],
      environmentVariables: {},
    });

    const logLines: string[] = [];
    const loggedTables: Array<Array<Record<string, unknown>>> = [];
    const summary = await executeSyncRun({
      adapter: mock.adapter,
      configuration,
      log: (line) => logLines.push(line),
      logTable: (tabularData) => {
        loggedTables.push(tabularData as Array<Record<string, unknown>>);
      },
    });

    assert.equal(summary.dryRun, true);
    assert.equal(mock.operationsLog.length, 0);
    assert.equal(fs.existsSync(stateFilePath), false);
    assert.equal(summary.totalUnchangedFilesCount, 1);
    assert.equal(summary.totalMovedOrRenamedFilesCount, 1);
    assert.equal(summary.totalNewFilesCount, 2);

    // Expect 3 tables: plan table (2 rows), dry-run actions table, and summary table (2 rows + TOTAL).
    assert.equal(loggedTables.length, 3);
    assert.equal(loggedTables[0]?.length, 2);
    assert.ok(
      loggedTables[1]?.some(
        (actionRow) =>
          actionRow.Mapping === '/One' &&
          actionRow.Action === 'move/rename' &&
          actionRow.Path === 'old-name.txt -> sub/relocated.txt' &&
          actionRow.Size === '13 B',
      ),
    );
    assert.equal(loggedTables[2]?.length, 3);
    assert.equal(loggedTables[2]?.[2]?.Mapping, 'TOTAL');
    assert.equal(loggedTables[2]?.[2]?.New, 2);
    assert.equal(loggedTables[2]?.[2]?.['Moved/Renamed'], 1);
    assert.equal(loggedTables[2]?.[2]?.Unchanged, 1);
    assert.ok(logLines.some((line) => line.includes('[DRY RUN] Planned actions')));
  });

  it('executes multi-mapping sync (create folders, move+rename, upload, revision update, batched trash) and persists incremental state', async () => {
    const unchangedSha1 = crypto.createHash('sha1').update('unchanged content').digest('hex');
    const movedSha1 = crypto.createHash('sha1').update('moved payload').digest('hex');

    const mock = createStatefulDriveMock([
      {
        nodeUid: 'root-uid',
        parentNodeUid: null,
        name: 'My files',
        nodeType: 'folder',
        treeEventScopeId: 'vol-1',
        isTrashed: false,
        sha1Hash: null,
        sizeInBytes: null,
        modificationTimeMs: 1000,
      },
      {
        nodeUid: 'r1-uid',
        parentNodeUid: 'root-uid',
        name: 'One',
        nodeType: 'folder',
        treeEventScopeId: 'vol-1',
        isTrashed: false,
        sha1Hash: null,
        sizeInBytes: null,
        modificationTimeMs: 1000,
      },
      {
        nodeUid: 'file-unchanged',
        parentNodeUid: 'r1-uid',
        name: 'unchanged.txt',
        nodeType: 'file',
        treeEventScopeId: 'vol-1',
        isTrashed: false,
        sha1Hash: unchangedSha1,
        sizeInBytes: 17,
        modificationTimeMs: 1000,
      },
      {
        nodeUid: 'file-updated',
        parentNodeUid: 'r1-uid',
        name: 'updated.txt',
        nodeType: 'file',
        treeEventScopeId: 'vol-1',
        isTrashed: false,
        sha1Hash: '0000000000000000000000000000000000000000',
        sizeInBytes: 10,
        modificationTimeMs: 1000,
      },
      {
        nodeUid: 'file-relocated',
        parentNodeUid: 'r1-uid',
        name: 'old-name.txt',
        nodeType: 'file',
        treeEventScopeId: 'vol-1',
        isTrashed: false,
        sha1Hash: movedSha1,
        sizeInBytes: 13,
        modificationTimeMs: 1000,
      },
      {
        nodeUid: 'empty-old-folder',
        parentNodeUid: 'r1-uid',
        name: 'unused-dir',
        nodeType: 'folder',
        treeEventScopeId: 'vol-1',
        isTrashed: false,
        sha1Hash: null,
        sizeInBytes: null,
        modificationTimeMs: 1000,
      },
      {
        nodeUid: 'file-obsolete',
        parentNodeUid: 'empty-old-folder',
        name: 'obsolete.txt',
        nodeType: 'file',
        treeEventScopeId: 'vol-1',
        isTrashed: false,
        sha1Hash: '9999999999999999999999999999999999999999',
        sizeInBytes: 5,
        modificationTimeMs: 1000,
      },
    ]);

    const configuration = parseApplicationConfiguration({
      argv: [
        '--map',
        `${localOne}:/One`,
        '--map',
        `${localTwo}:/Backups/Two`,
        '--delete-empty-dirs',
        '--state-file',
        stateFilePath,
        '--session-file',
        sessionFilePath,
        '--encryption-key-file',
        encryptionKeyFilePath,
      ],
      environmentVariables: {},
    });

    const firstLoggedTables: Array<Array<Record<string, unknown>>> = [];
    const firstSummary = await executeSyncRun({
      adapter: mock.adapter,
      configuration,
      log: () => {},
      logTable: (tabularData) => {
        firstLoggedTables.push(tabularData as Array<Record<string, unknown>>);
      },
    });

    assert.equal(firstSummary.mappingSummaries.length, 2);
    assert.equal(firstSummary.totalNewFilesCount, 1);
    assert.equal(firstSummary.totalUpdatedFilesCount, 1);
    assert.equal(firstSummary.totalMovedOrRenamedFilesCount, 1);
    assert.equal(firstSummary.totalUnchangedFilesCount, 1);
    assert.equal(firstSummary.totalTrashedFilesCount, 1);
    assert.equal(firstSummary.totalTrashedEmptyFoldersCount, 1);
    assert.equal(firstLoggedTables.length, 2);
    assert.equal(firstLoggedTables[1]?.[2]?.Mapping, 'TOTAL');
    assert.equal(firstLoggedTables[1]?.[2]?.Trashed, 1);
    assert.equal(firstLoggedTables[1]?.[2]?.['Empty Dirs'], 1);

    // Ensure `uploadRevision` was called for `updated.txt`, `uploadNew` for `second-root.txt`,
    // and obsolete child `file-obsolete` inside `empty-old-folder` was deduplicated into one trash call.
    assert.ok(mock.operationsLog.includes('uploadRevision:file-updated:updated.txt'));
    assert.ok(mock.operationsLog.some((entry) => entry.startsWith('uploadNew:') && entry.endsWith(':second-root.txt')));
    const trashLogEntries = mock.operationsLog.filter((entry) => entry.startsWith('trash:'));
    assert.deepEqual(trashLogEntries, ['trash:empty-old-folder']);

    // Verify state.json on disk is encrypted (never exposes plaintext paths or UIDs).
    const rawDiskStateText = fs.readFileSync(stateFilePath, 'utf8');
    assert.equal(rawDiskStateText.includes('/Backups/Two'), false);
    assert.equal(rawDiskStateText.includes('root-uid'), false);

    const savedState = await loadPersistedRemoteState(stateFilePath, {
      encryptionKey: masterEncryptionKey,
    });
    assert.ok(savedState);
    assert.ok(savedState.mappings['/One']);
    assert.ok(savedState.mappings['/Backups/Two']);

    // Second run uses incremental event sync and sees zero pending actions!
    mock.operationsLog.length = 0;
    const secondSummary = await executeSyncRun({
      adapter: mock.adapter,
      configuration,
      log: () => {},
      logTable: () => {},
    });

    assert.equal(secondSummary.usedIncrementalEvents, true);
    assert.equal(secondSummary.totalNewFilesCount, 0);
    assert.equal(secondSummary.totalUpdatedFilesCount, 0);
    assert.equal(secondSummary.totalMovedOrRenamedFilesCount, 0);
    assert.equal(secondSummary.totalTrashedFilesCount, 0);
    assert.equal(secondSummary.totalUnchangedFilesCount, 4);
    assert.equal(mock.operationsLog.length, 0);
  });

  it('aborts fail-fast before trashing obsolete files when an upload fails', async () => {
    const mock = createStatefulDriveMock([
      {
        nodeUid: 'root-uid',
        parentNodeUid: null,
        name: 'My files',
        nodeType: 'folder',
        treeEventScopeId: 'vol-1',
        isTrashed: false,
        sha1Hash: null,
        sizeInBytes: null,
        modificationTimeMs: 1000,
      },
      {
        nodeUid: 'r1-uid',
        parentNodeUid: 'root-uid',
        name: 'FailCheck',
        nodeType: 'folder',
        treeEventScopeId: 'vol-1',
        isTrashed: false,
        sha1Hash: null,
        sizeInBytes: null,
        modificationTimeMs: 1000,
      },
      {
        nodeUid: 'file-obsolete',
        parentNodeUid: 'r1-uid',
        name: 'stale.txt',
        nodeType: 'file',
        treeEventScopeId: 'vol-1',
        isTrashed: false,
        sha1Hash: '9999999999999999999999999999999999999999',
        sizeInBytes: 5,
        modificationTimeMs: 1000,
      },
    ]);
    mock.setFailNextUpload(true);

    const freshStatePath = path.join(temporaryRoot, 'data', 'fail-state.json');
    const configuration = parseApplicationConfiguration({
      argv: [
        '--map',
        `${localTwo}:/FailCheck`,
        '--state-file',
        freshStatePath,
        '--encryption-key-file',
        encryptionKeyFilePath,
      ],
      environmentVariables: {},
    });

    await assert.rejects(
      () => executeSyncRun({ adapter: mock.adapter, configuration, log: () => {}, logTable: () => {} }),
      /Simulated upload failure/,
    );
    assert.equal(mock.operationsLog.some((entry) => entry.startsWith('trash:')), false);
  });

  it('logs partial trash failures without aborting remaining trash items', async () => {
    const mock = createStatefulDriveMock([
      {
        nodeUid: 'root-uid',
        parentNodeUid: null,
        name: 'My files',
        nodeType: 'folder',
        treeEventScopeId: 'vol-1',
        isTrashed: false,
        sha1Hash: null,
        sizeInBytes: null,
        modificationTimeMs: 1000,
      },
      {
        nodeUid: 'r1-uid',
        parentNodeUid: 'root-uid',
        name: 'PartialTrash',
        nodeType: 'folder',
        treeEventScopeId: 'vol-1',
        isTrashed: false,
        sha1Hash: null,
        sizeInBytes: null,
        modificationTimeMs: 1000,
      },
      {
        nodeUid: 'file-obsolete-fail',
        parentNodeUid: 'r1-uid',
        name: 'fail.txt',
        nodeType: 'file',
        treeEventScopeId: 'vol-1',
        isTrashed: false,
        sha1Hash: '1111111111111111111111111111111111111111',
        sizeInBytes: 5,
        modificationTimeMs: 1000,
      },
      {
        nodeUid: 'file-obsolete-ok',
        parentNodeUid: 'r1-uid',
        name: 'ok.txt',
        nodeType: 'file',
        treeEventScopeId: 'vol-1',
        isTrashed: false,
        sha1Hash: '2222222222222222222222222222222222222222',
        sizeInBytes: 5,
        modificationTimeMs: 1000,
      },
    ]);
    mock.setFailTrashForUid('file-obsolete-fail');

    const partialStatePath = path.join(temporaryRoot, 'data', 'partial-trash-state.json');
    const configuration = parseApplicationConfiguration({
      argv: [
        '--map',
        `${localTwo}:/PartialTrash`,
        '--state-file',
        partialStatePath,
        '--encryption-key-file',
        encryptionKeyFilePath,
      ],
      environmentVariables: {},
    });

    const loggedErrors: string[] = [];
    const summary = await executeSyncRun({
      adapter: mock.adapter,
      configuration,
      log: () => {},
      logTable: () => {},
      logError: (errorLine) => loggedErrors.push(errorLine),
    });

    assert.equal(summary.totalTrashedFilesCount, 1);
    assert.equal(summary.totalFailedTrashCount, 1);
    assert.ok(loggedErrors.some((line) => line.includes('fail.txt')));
  });

  it('batches shared root folder creation, parallelizes uploads/sibling folders, and consolidates trash across mappings', async () => {
    const batchLocalOne = path.join(temporaryRoot, 'batch-one');
    const batchLocalTwo = path.join(temporaryRoot, 'batch-two');
    fs.mkdirSync(path.join(batchLocalOne, 'dirA'), { recursive: true });
    fs.mkdirSync(path.join(batchLocalOne, 'dirB'), { recursive: true });
    fs.mkdirSync(path.join(batchLocalTwo, 'dirC'), { recursive: true });

    fs.writeFileSync(path.join(batchLocalOne, 'dirA', '1.txt'), 'one', 'utf8');
    fs.writeFileSync(path.join(batchLocalOne, 'dirB', '2.txt'), 'two', 'utf8');
    fs.writeFileSync(path.join(batchLocalTwo, 'dirC', '3.txt'), 'three', 'utf8');
    fs.writeFileSync(path.join(batchLocalTwo, 'dirC', '4.txt'), 'four', 'utf8');

    const mock = createStatefulDriveMock(
      [
        {
          nodeUid: 'root-uid',
          parentNodeUid: null,
          name: 'My files',
          nodeType: 'folder',
          treeEventScopeId: 'vol-1',
          isTrashed: false,
          sha1Hash: null,
          sizeInBytes: null,
          modificationTimeMs: 1000,
        },
        {
          nodeUid: 'existing-m1-root',
          parentNodeUid: 'root-uid',
          name: 'SharedRoot',
          nodeType: 'folder',
          treeEventScopeId: 'vol-1',
          isTrashed: false,
          sha1Hash: null,
          sizeInBytes: null,
          modificationTimeMs: 1000,
        },
        {
          nodeUid: 'existing-m1-sub',
          parentNodeUid: 'existing-m1-root',
          name: 'MapOne',
          nodeType: 'folder',
          treeEventScopeId: 'vol-1',
          isTrashed: false,
          sha1Hash: null,
          sizeInBytes: null,
          modificationTimeMs: 1000,
        },
        {
          nodeUid: 'm1-stale',
          parentNodeUid: 'existing-m1-sub',
          name: 'old1.txt',
          nodeType: 'file',
          treeEventScopeId: 'vol-1',
          isTrashed: false,
          sha1Hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          sizeInBytes: 3,
          modificationTimeMs: 1000,
        },
      ],
      'evt-1',
      {
        uploadDelayMs: 15,
        folderCreateDelayMs: 10,
      },
    );

    const batchStatePath = path.join(temporaryRoot, 'data', 'batch-state.json');
    const configuration = parseApplicationConfiguration({
      argv: [
        '--map',
        `${batchLocalOne}:/SharedRoot/MapOne`,
        '--map',
        `${batchLocalTwo}:/SharedRoot/NewParent/MapTwo`,
        '--concurrency',
        '3',
        '--state-file',
        batchStatePath,
        '--encryption-key-file',
        encryptionKeyFilePath,
      ],
      environmentVariables: {},
    });

    const summary = await executeSyncRun({
      adapter: mock.adapter,
      configuration,
      log: () => {},
      logTable: () => {},
    });

    assert.equal(summary.totalNewFilesCount, 4);
    assert.equal(summary.totalTrashedFilesCount, 1);
    assert.ok(mock.getPeakActiveFolderCreates() > 1);
    assert.equal(mock.getPeakActiveUploads(), 3);

    // Consolidated trash issues a single bulk call even across multiple mappings.
    const trashLogs = mock.operationsLog.filter((entry) => entry.startsWith('trash:'));
    assert.deepEqual(trashLogs, ['trash:m1-stale']);
  });

  it('emits credential-safe [verbose] diagnostic logs only when --verbose is enabled', async () => {
    const verboseLocalDirectory = path.join(temporaryRoot, 'verbose-local');
    fs.mkdirSync(path.join(verboseLocalDirectory, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(verboseLocalDirectory, 'nested', 'item.txt'), 'verbose payload', 'utf8');

    const createMock = () =>
      createStatefulDriveMock([
        {
          nodeUid: 'root-uid',
          parentNodeUid: null,
          name: 'My files',
          nodeType: 'folder',
          treeEventScopeId: 'vol-verbose',
          isTrashed: false,
          sha1Hash: null,
          sizeInBytes: null,
          modificationTimeMs: 1000,
        },
      ]);

    const quietStateFilePath = path.join(temporaryRoot, 'data', 'quiet-state.json');
    const quietLogs: string[] = [];
    await executeSyncRun({
      adapter: createMock().adapter,
      configuration: parseApplicationConfiguration({
        argv: [
          '--map',
          `${verboseLocalDirectory}:/VerboseQuiet`,
          '--state-file',
          quietStateFilePath,
          '--encryption-key-file',
          encryptionKeyFilePath,
        ],
        environmentVariables: {},
      }),
      log: (line) => quietLogs.push(line),
      logTable: () => {},
    });
    assert.equal(quietLogs.some((line) => line.includes('[verbose]')), false);

    const verboseStateFilePath = path.join(temporaryRoot, 'data', 'verbose-state.json');
    const verboseLogs: string[] = [];
    await executeSyncRun({
      adapter: createMock().adapter,
      configuration: parseApplicationConfiguration({
        argv: [
          '--map',
          `${verboseLocalDirectory}:/VerboseEnabled`,
          '--state-file',
          verboseStateFilePath,
          '--encryption-key-file',
          encryptionKeyFilePath,
          '--verbose',
        ],
        environmentVariables: {},
      }),
      log: (line) => verboseLogs.push(line),
      logTable: () => {},
    });

    assert.ok(verboseLogs.some((line) => line.includes('[verbose] Starting Phase 1')));
    assert.ok(verboseLogs.some((line) => line.includes('[verbose] Created remote folder')));
    assert.ok(verboseLogs.some((line) => line.includes('[verbose] Uploading (new): nested/item.txt')));
    assert.ok(verboseLogs.some((line) => line.includes('[verbose] Persisted state cache to')));
  });
});
