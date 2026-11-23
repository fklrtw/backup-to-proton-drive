import assert from 'node:assert/strict';
import * as fileSystem from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { recordSyncCompletion, recordSyncFailure } from '../src/runStatus.ts';
import { startStatusServer, type StatusServerHandle } from '../src/statusServer.ts';
import type { OverallSyncSummary } from '../src/types.ts';

function buildSuccessfulSummary(): OverallSyncSummary {
  return {
    dryRun: false,
    usedIncrementalEvents: true,
    eventsProcessedCount: 1,
    mappingSummaries: [],
    totalNewFilesCount: 0,
    totalUpdatedFilesCount: 1,
    totalMovedOrRenamedFilesCount: 0,
    totalUnchangedFilesCount: 25,
    totalTrashedFilesCount: 0,
    totalTrashedEmptyFoldersCount: 0,
    totalFailedTrashCount: 0,
    totalBytesTransferred: 2048,
    totalBytesSavedByMoves: 0,
    totalDurationSeconds: 1.5,
  };
}

describe('statusServer HTTP endpoints', () => {
  let temporaryRootDirectory = '';
  let statusFilePath = '';
  let serverHandle: StatusServerHandle | undefined;
  let currentSimulatedDate = new Date('2026-11-23T12:00:00.000Z');

  beforeEach(() => {
    temporaryRootDirectory = fileSystem.mkdtempSync(
      path.join(os.tmpdir(), 'proton-backup-status-server-test-'),
    );
    statusFilePath = path.join(temporaryRootDirectory, 'status.json');
    currentSimulatedDate = new Date('2026-11-23T12:00:00.000Z');
  });

  afterEach(async () => {
    if (serverHandle) {
      await serverHandle.close();
      serverHandle = undefined;
    }
    fileSystem.rmSync(temporaryRootDirectory, { recursive: true, force: true });
  });

  it('serves /status and /status.json with 200 and /health with 200/503 across states', async () => {
    serverHandle = await startStatusServer({
      statusFilePath,
      host: '127.0.0.1',
      port: 0,
      maxAgeHours: 26,
      nowProvider: () => currentSimulatedDate,
    });
    const baseUrl = `http://127.0.0.1:${serverHandle.port}`;

    // 1. Before any sync runs: /status returns 200 with problem=true; /health returns 503.
    const initialStatusResponse = await fetch(`${baseUrl}/status`);
    assert.equal(initialStatusResponse.status, 200);
    assert.equal(initialStatusResponse.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(initialStatusResponse.headers.get('cache-control'), 'no-store');
    const initialStatusBody = (await initialStatusResponse.json()) as Record<string, unknown>;
    assert.equal(initialStatusBody.status, 'never_run');
    assert.equal(initialStatusBody.problem, true);
    assert.equal(initialStatusBody.healthy, false);

    const initialHealthResponse = await fetch(`${baseUrl}/health`);
    assert.equal(initialHealthResponse.status, 503);

    // 2. After a healthy sync: /status and /status.json return healthy=true; /health returns 200.
    recordSyncCompletion(statusFilePath, buildSuccessfulSummary(), new Date('2026-11-23T10:00:00.000Z'));

    const healthyStatusResponse = await fetch(`${baseUrl}/status.json`);
    assert.equal(healthyStatusResponse.status, 200);
    const healthyStatusBody = (await healthyStatusResponse.json()) as Record<string, unknown>;
    assert.equal(healthyStatusBody.status, 'ok');
    assert.equal(healthyStatusBody.overdue, false);
    assert.equal(healthyStatusBody.problem, false);
    assert.equal(healthyStatusBody.healthy, true);

    const healthyResponse = await fetch(`${baseUrl}/health`);
    assert.equal(healthyResponse.status, 200);

    // 3. After a failure: /status still returns 200 JSON with problem=true; /health returns 503.
    recordSyncFailure(statusFilePath, new Error('Upstream unavailable'), 3.2, new Date('2026-11-23T11:00:00.000Z'));

    const failedStatusResponse = await fetch(`${baseUrl}/status`);
    assert.equal(failedStatusResponse.status, 200);
    const failedStatusBody = (await failedStatusResponse.json()) as Record<string, unknown>;
    assert.equal(failedStatusBody.status, 'error');
    assert.equal(failedStatusBody.problem, true);
    assert.equal(failedStatusBody.errorMessage, 'Upstream unavailable');

    const failedHealthResponse = await fetch(`${baseUrl}/health`);
    assert.equal(failedHealthResponse.status, 503);

    // 4. After an ok sync that goes stale past maxAgeHours: /health returns 503.
    recordSyncCompletion(statusFilePath, buildSuccessfulSummary(), new Date('2026-11-21T00:00:00.000Z'));
    const overdueStatusResponse = await fetch(`${baseUrl}/status`);
    assert.equal(overdueStatusResponse.status, 200);
    const overdueStatusBody = (await overdueStatusResponse.json()) as Record<string, unknown>;
    assert.equal(overdueStatusBody.overdue, true);
    assert.equal(overdueStatusBody.problem, true);
    assert.equal((await fetch(`${baseUrl}/health`)).status, 503);
  });

  it('supports HEAD requests and rejects unsupported HTTP methods and unknown paths', async () => {
    serverHandle = await startStatusServer({
      statusFilePath,
      host: '127.0.0.1',
      port: 0,
      maxAgeHours: 26,
      nowProvider: () => currentSimulatedDate,
    });
    const baseUrl = `http://127.0.0.1:${serverHandle.port}`;

    const headResponse = await fetch(`${baseUrl}/status`, { method: 'HEAD' });
    assert.equal(headResponse.status, 200);
    assert.ok(Number(headResponse.headers.get('content-length')) > 0);
    assert.equal(await headResponse.text(), '');

    const postResponse = await fetch(`${baseUrl}/status`, { method: 'POST' });
    assert.equal(postResponse.status, 405);
    assert.equal(postResponse.headers.get('allow'), 'GET, HEAD');

    const notFoundResponse = await fetch(`${baseUrl}/unknown-route`);
    assert.equal(notFoundResponse.status, 404);
  });
});
