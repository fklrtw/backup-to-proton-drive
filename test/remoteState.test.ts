import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  loadPersistedRemoteState,
  savePersistedRemoteState,
  synchronizeRemoteState,
} from '../src/remoteState.ts';
import type {
  DirectoryMapping,
  DriveTreeEvent,
  LocalFileEntry,
  PersistedRemoteState,
  ProtonDriveAdapter,
  RawRemoteNode,
} from '../src/types.ts';

/**
 * Creates a deterministic in-memory mock implementing {@link ProtonDriveAdapter}
 * for testing full scans, incremental tree events, and refresh fallbacks.
 */
function createMockStateAdapter(initialState: {
  nodes: RawRemoteNode[];
  headEventId: string;
  eventsAfterCursor?: Map<string, DriveTreeEvent[]>;
  listDelayMs?: number;
}) {
  const nodesByUid = new Map<string, RawRemoteNode>();
  for (const node of initialState.nodes) {
    nodesByUid.set(node.nodeUid, node);
  }

  let listChildrenCalls = 0;
  let activeListCalls = 0;
  let peakActiveListCalls = 0;
  let headEventId = initialState.headEventId;
  const eventsByCursor = initialState.eventsAfterCursor ?? new Map<string, DriveTreeEvent[]>();

  const adapter: ProtonDriveAdapter = {
    async getMyFilesRootFolder(): Promise<RawRemoteNode> {
      const rootNode = nodesByUid.get('root-uid');
      if (!rootNode) {
        throw new Error('Mock root node missing');
      }
      return rootNode;
    },

    async listFolderChildren(parentNodeUid: string): Promise<RawRemoteNode[]> {
      listChildrenCalls++;
      activeListCalls++;
      peakActiveListCalls = Math.max(peakActiveListCalls, activeListCalls);
      if (initialState.listDelayMs && initialState.listDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, initialState.listDelayMs));
      }
      try {
        return Array.from(nodesByUid.values()).filter(
          (node) => node.parentNodeUid === parentNodeUid && !node.isTrashed,
        );
      } finally {
        activeListCalls--;
      }
    },

    async getNodesByUids(nodeUids: string[]): Promise<Map<string, RawRemoteNode | null>> {
      const results = new Map<string, RawRemoteNode | null>();
      for (const nodeUid of nodeUids) {
        results.set(nodeUid, nodesByUid.get(nodeUid) ?? null);
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
        hierarchy.unshift(node);
        currentUid = node.parentNodeUid;
      }
      return hierarchy;
    },

    async getLatestEventId(): Promise<string> {
      return headEventId;
    },

    async *iterateEvents(_treeEventScopeId: string, lastEventId: string): AsyncIterable<DriveTreeEvent> {
      const events = eventsByCursor.get(lastEventId) ?? [];
      for (const treeEvent of events) {
        yield treeEvent;
      }
    },

    async createFolder(): Promise<RawRemoteNode> {
      throw new Error('Not used in remoteState test');
    },
    async uploadNewFile(
      _parentNodeUid: string,
      _localFile: LocalFileEntry,
    ): Promise<{ nodeUid: string; revisionUid: string }> {
      throw new Error('Not used in remoteState test');
    },
    async uploadFileRevision(): Promise<{ nodeUid: string; revisionUid: string }> {
      throw new Error('Not used in remoteState test');
    },
    async renameNode(): Promise<RawRemoteNode> {
      throw new Error('Not used in remoteState test');
    },
    async moveNode(): Promise<void> {
      throw new Error('Not used in remoteState test');
    },
    async trashNodes(): Promise<Array<{ nodeUid: string; succeeded: boolean }>> {
      throw new Error('Not used in remoteState test');
    },
  };

  return {
    adapter,
    nodesByUid,
    getListChildrenCalls: () => listChildrenCalls,
    getPeakActiveListCalls: () => peakActiveListCalls,
    resetListChildrenCalls: () => {
      listChildrenCalls = 0;
      peakActiveListCalls = 0;
    },
    setHeadEventId: (nextEventId: string) => {
      headEventId = nextEventId;
    },
    eventsByCursor,
  };
}

describe('remoteState', () => {
  let temporaryRoot = '';

  before(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'proton-backup-state-test-'));
  });

  after(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it('persists and reloads state files cleanly in both encrypted and explicit plaintext modes with 0600 permissions', async () => {
    const encryptedStateFilePath = path.join(temporaryRoot, 'nested', 'state.json');
    const masterEncryptionKey = Buffer.from('remote-state-encryption-test-key-at-least-32-bytes', 'utf8');
    const encryptedStorageOptions = { encryptionKey: masterEncryptionKey };
    const sampleState: PersistedRemoteState = {
      schemaVersion: 1,
      treeEventScopeId: 'vol-1',
      lastEventId: 'evt-1',
      myFilesRootNodeUid: 'root-uid',
      mappings: {},
      updatedAtIso: '2026-01-01T00:00:00.000Z',
    };

    await savePersistedRemoteState(encryptedStateFilePath, sampleState, encryptedStorageOptions);
    const encryptedRawText = fs.readFileSync(encryptedStateFilePath, 'utf8');
    assert.equal(encryptedRawText.includes('root-uid'), false);

    const loadedEncryptedState = await loadPersistedRemoteState(
      encryptedStateFilePath,
      encryptedStorageOptions,
    );
    assert.deepEqual(loadedEncryptedState, sampleState);

    const fileMode = fs.statSync(encryptedStateFilePath).mode & 0o777;
    assert.equal(fileMode, 0o600);
    assert.equal(
      await loadPersistedRemoteState(path.join(temporaryRoot, 'missing.json'), encryptedStorageOptions),
      null,
    );

    const plaintextStateFilePath = path.join(temporaryRoot, 'nested', 'plaintext-state.json');
    await savePersistedRemoteState(plaintextStateFilePath, sampleState, { allowPlaintext: true });
    const loadedPlaintextState = await loadPersistedRemoteState(plaintextStateFilePath, {
      allowPlaintext: true,
    });
    assert.deepEqual(loadedPlaintextState, sampleState);
  });

  it('bootstraps via full scan, applies incremental events without directory listing, and falls back on tree_refresh', async () => {
    const mock = createMockStateAdapter({
      headEventId: 'evt-100',
      nodes: [
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
          nodeUid: 'backups-uid',
          parentNodeUid: 'root-uid',
          name: 'Backups',
          nodeType: 'folder',
          treeEventScopeId: 'vol-1',
          isTrashed: false,
          sha1Hash: null,
          sizeInBytes: null,
          modificationTimeMs: 1000,
        },
        {
          nodeUid: 'docs-uid',
          parentNodeUid: 'backups-uid',
          name: 'Docs',
          nodeType: 'folder',
          treeEventScopeId: 'vol-1',
          isTrashed: false,
          sha1Hash: null,
          sizeInBytes: null,
          modificationTimeMs: 1000,
        },
        {
          nodeUid: 'file-1-uid',
          parentNodeUid: 'docs-uid',
          name: 'a.txt',
          nodeType: 'file',
          treeEventScopeId: 'vol-1',
          isTrashed: false,
          sha1Hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          sizeInBytes: 10,
          modificationTimeMs: 1000,
        },
      ],
    });

    const mappings: DirectoryMapping[] = [
      {
        localDirectory: '/local/docs',
        remoteDirectory: '/Backups/Docs',
        excludePatterns: [],
        trashObsolete: true,
        deleteEmptyRemoteDirectories: false,
      },
    ];

    // Run 1: initial bootstrap performs full walk and records event cursor `evt-100`.
    const bootstrapResult = await synchronizeRemoteState({
      adapter: mock.adapter,
      mappings,
      existingState: null,
    });
    assert.equal(bootstrapResult.usedIncrementalEvents, false);
    assert.equal(bootstrapResult.state.lastEventId, 'evt-100');
    assert.ok(bootstrapResult.snapshotsByRemoteDirectory.get('/Backups/Docs')?.filesByRelativePath.has('a.txt'));

    // Simulate remote mutations: create sub-folder + file inside it, update a.txt -> b.txt, delete nothing yet.
    mock.nodesByUid.set('sub-uid', {
      nodeUid: 'sub-uid',
      parentNodeUid: 'docs-uid',
      name: 'Sub',
      nodeType: 'folder',
      treeEventScopeId: 'vol-1',
      isTrashed: false,
      sha1Hash: null,
      sizeInBytes: null,
      modificationTimeMs: 2000,
    });
    mock.nodesByUid.set('file-2-uid', {
      nodeUid: 'file-2-uid',
      parentNodeUid: 'sub-uid',
      name: 'c.txt',
      nodeType: 'file',
      treeEventScopeId: 'vol-1',
      isTrashed: false,
      sha1Hash: 'cccccccccccccccccccccccccccccccccccccccc',
      sizeInBytes: 25,
      modificationTimeMs: 2000,
    });
    mock.nodesByUid.set('file-1-uid', {
      nodeUid: 'file-1-uid',
      parentNodeUid: 'docs-uid',
      name: 'b.txt',
      nodeType: 'file',
      treeEventScopeId: 'vol-1',
      isTrashed: false,
      sha1Hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      sizeInBytes: 12,
      modificationTimeMs: 2000,
    });

    mock.eventsByCursor.set('evt-100', [
      { type: 'node_created', nodeUid: 'sub-uid', parentNodeUid: 'docs-uid', isTrashed: false, eventId: 'evt-101' },
      { type: 'node_created', nodeUid: 'file-2-uid', parentNodeUid: 'sub-uid', isTrashed: false, eventId: 'evt-102' },
      { type: 'node_updated', nodeUid: 'file-1-uid', parentNodeUid: 'docs-uid', isTrashed: false, eventId: 'evt-103' },
    ]);

    mock.resetListChildrenCalls();

    // Run 2: incremental event sync applies changes WITHOUT calling listFolderChildren!
    const incrementalResult = await synchronizeRemoteState({
      adapter: mock.adapter,
      mappings,
      existingState: bootstrapResult.state,
    });
    assert.equal(incrementalResult.usedIncrementalEvents, true);
    assert.equal(incrementalResult.eventsProcessedCount, 3);
    assert.equal(incrementalResult.state.lastEventId, 'evt-103');
    assert.equal(mock.getListChildrenCalls(), 0);

    const updatedSnapshot = incrementalResult.snapshotsByRemoteDirectory.get('/Backups/Docs');
    assert.equal(updatedSnapshot?.filesByRelativePath.has('a.txt'), false);
    assert.equal(updatedSnapshot?.filesByRelativePath.get('b.txt')?.sha1Hash, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    assert.equal(updatedSnapshot?.filesByRelativePath.get('Sub/c.txt')?.nodeUid, 'file-2-uid');

    // Run 3: a `tree_refresh` event forces full rescan at updated head cursor.
    mock.setHeadEventId('evt-200');
    mock.eventsByCursor.set('evt-103', [{ type: 'tree_refresh', eventId: 'evt-200' }]);
    const refreshFallbackResult = await synchronizeRemoteState({
      adapter: mock.adapter,
      mappings,
      existingState: incrementalResult.state,
    });
    assert.equal(refreshFallbackResult.usedIncrementalEvents, false);
    assert.equal(refreshFallbackResult.state.lastEventId, 'evt-200');
    assert.ok(mock.getListChildrenCalls() > 0);
  });

  it('scans sibling remote folders concurrently on cold bootstrap scans', async () => {
    const mock = createMockStateAdapter({
      headEventId: 'evt-500',
      listDelayMs: 10,
      nodes: [
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
          nodeUid: 'target-uid',
          parentNodeUid: 'root-uid',
          name: 'Parallel',
          nodeType: 'folder',
          treeEventScopeId: 'vol-1',
          isTrashed: false,
          sha1Hash: null,
          sizeInBytes: null,
          modificationTimeMs: 1000,
        },
        {
          nodeUid: 'sib-1',
          parentNodeUid: 'target-uid',
          name: 'Dir1',
          nodeType: 'folder',
          treeEventScopeId: 'vol-1',
          isTrashed: false,
          sha1Hash: null,
          sizeInBytes: null,
          modificationTimeMs: 1000,
        },
        {
          nodeUid: 'sib-2',
          parentNodeUid: 'target-uid',
          name: 'Dir2',
          nodeType: 'folder',
          treeEventScopeId: 'vol-1',
          isTrashed: false,
          sha1Hash: null,
          sizeInBytes: null,
          modificationTimeMs: 1000,
        },
        {
          nodeUid: 'sib-3',
          parentNodeUid: 'target-uid',
          name: 'Dir3',
          nodeType: 'folder',
          treeEventScopeId: 'vol-1',
          isTrashed: false,
          sha1Hash: null,
          sizeInBytes: null,
          modificationTimeMs: 1000,
        },
      ],
    });

    const result = await synchronizeRemoteState({
      adapter: mock.adapter,
      mappings: [
        {
          localDirectory: '/local/parallel',
          remoteDirectory: '/Parallel',
          excludePatterns: [],
          trashObsolete: true,
          deleteEmptyRemoteDirectories: false,
        },
      ],
      existingState: null,
      remoteScanConcurrency: 3,
    });

    assert.equal(result.snapshotsByRemoteDirectory.get('/Parallel')?.foldersByRelativePath.size, 4);
    assert.equal(mock.getPeakActiveListCalls(), 3);
  });
});
