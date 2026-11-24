import assert from 'node:assert/strict';
import * as fileSystem from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  markSyncRunStarted,
  recordSyncCompletion,
  recordSyncFailure,
} from '../src/runStatus.ts';
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
    assert.equal(initialStatusBody.triggerEnabled, false);
    assert.equal(initialStatusBody.triggerAvailable, false);
    assert.equal(initialStatusBody.triggerPending, false);
    assert.equal(initialStatusBody.triggerCooldownSeconds, null);
    assert.equal(initialStatusBody.triggerCooldownRemainingSeconds, null);
    assert.equal(initialStatusBody.triggerAvailableAt, null);

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

    const disabledTriggerResponse = await fetch(`${baseUrl}/trigger`, { method: 'POST' });
    assert.equal(disabledTriggerResponse.status, 404);
  });

  it('enforces method, bearer authentication, running guard, pending trigger, and cooldown on POST /trigger', async () => {
    const triggerFilePath = path.join(temporaryRootDirectory, 'trigger', 'backup.trigger');
    const triggerToken = Buffer.from('status-server-test-bearer-token-at-least-32-bytes', 'utf8');
    const authorizationHeader = `Bearer ${triggerToken.toString('utf8')}`;

    serverHandle = await startStatusServer({
      statusFilePath,
      host: '127.0.0.1',
      port: 0,
      maxAgeHours: 26,
      triggerFilePath,
      triggerToken,
      triggerCooldownSeconds: 900,
      nowProvider: () => currentSimulatedDate,
    });
    const baseUrl = `http://127.0.0.1:${serverHandle.port}`;

    // Unsupported HTTP methods on /trigger return 405 with Allow: POST.
    for (const unsupportedMethod of ['GET', 'HEAD']) {
      const methodNotAllowedResponse = await fetch(`${baseUrl}/trigger`, {
        method: unsupportedMethod,
      });
      assert.equal(methodNotAllowedResponse.status, 405);
      assert.equal(methodNotAllowedResponse.headers.get('allow'), 'POST');
    }

    // Invalid or missing authorization headers return 401 without creating the trigger file.
    const invalidAuthorizationHeaders: Array<string | undefined> = [
      undefined,
      'Basic dXNlcjpwYXNz',
      `Bearer ${triggerToken.toString('utf8')} extra-token`,
      'Bearer wrong-token-value',
    ];
    for (const candidateAuthorizationHeader of invalidAuthorizationHeaders) {
      const requestHeaders: Record<string, string> = {};
      if (candidateAuthorizationHeader !== undefined) {
        requestHeaders.Authorization = candidateAuthorizationHeader;
      }
      const unauthorizedResponse = await fetch(`${baseUrl}/trigger`, {
        method: 'POST',
        headers: requestHeaders,
      });
      assert.equal(unauthorizedResponse.status, 401);
      assert.equal(
        unauthorizedResponse.headers.get('www-authenticate'),
        'Bearer realm="backup-to-proton-drive"',
      );
      assert.equal(fileSystem.existsSync(triggerFilePath), false);
    }

    // Initial /status reports triggerEnabled=true and triggerAvailable=true.
    const initialStatusResponse = await fetch(`${baseUrl}/status`);
    assert.equal(initialStatusResponse.status, 200);
    const initialStatusBody = (await initialStatusResponse.json()) as Record<string, unknown>;
    assert.equal(initialStatusBody.triggerEnabled, true);
    assert.equal(initialStatusBody.triggerAvailable, true);
    assert.equal(initialStatusBody.triggerPending, false);
    assert.equal(initialStatusBody.triggerCooldownSeconds, 900);
    assert.equal(initialStatusBody.triggerCooldownRemainingSeconds, 0);
    assert.equal(initialStatusBody.triggerAvailableAt, null);

    // Valid POST /trigger creates trigger file atomically and returns 202 Accepted.
    const acceptedResponse = await fetch(`${baseUrl}/trigger`, {
      method: 'POST',
      headers: { Authorization: authorizationHeader },
    });
    assert.equal(acceptedResponse.status, 202);
    const acceptedBody = (await acceptedResponse.json()) as Record<string, unknown>;
    assert.equal(acceptedBody.triggered, true);
    assert.equal(acceptedBody.reason, 'accepted');
    assert.equal(acceptedBody.requestedAt, currentSimulatedDate.toISOString());
    assert.equal(acceptedBody.triggerPending, true);

    const persistedTriggerPayload = JSON.parse(
      fileSystem.readFileSync(triggerFilePath, 'utf8'),
    ) as { requestedAt: string };
    assert.equal(persistedTriggerPayload.requestedAt, currentSimulatedDate.toISOString());

    // Immediate second POST /trigger while trigger file exists returns 409 trigger_pending.
    const pendingConflictResponse = await fetch(`${baseUrl}/trigger`, {
      method: 'POST',
      headers: { Authorization: authorizationHeader },
    });
    assert.equal(pendingConflictResponse.status, 409);
    const pendingConflictBody = (await pendingConflictResponse.json()) as Record<string, unknown>;
    assert.equal(pendingConflictBody.triggered, false);
    assert.equal(pendingConflictBody.reason, 'trigger_pending');
    assert.equal(pendingConflictBody.triggerPending, true);

    const statusWhilePending = (await (await fetch(`${baseUrl}/status`)).json()) as Record<
      string,
      unknown
    >;
    assert.equal(statusWhilePending.triggerPending, true);
    assert.equal(statusWhilePending.triggerAvailable, false);
    assert.equal(statusWhilePending.triggerCooldownRemainingSeconds, null);

    // Running guard returns 409 already_running both while trigger file exists and after cleanup.
    markSyncRunStarted(statusFilePath, currentSimulatedDate);
    const runningWithTriggerFileResponse = await fetch(`${baseUrl}/trigger`, {
      method: 'POST',
      headers: { Authorization: authorizationHeader },
    });
    assert.equal(runningWithTriggerFileResponse.status, 409);
    const runningWithTriggerFileBody =
      (await runningWithTriggerFileResponse.json()) as Record<string, unknown>;
    assert.equal(runningWithTriggerFileBody.triggered, false);
    assert.equal(runningWithTriggerFileBody.reason, 'already_running');
    assert.equal(runningWithTriggerFileBody.running, true);
    assert.equal(
      runningWithTriggerFileBody.currentRunStartedAt,
      currentSimulatedDate.toISOString(),
    );

    fileSystem.rmSync(triggerFilePath, { force: true });
    const runningWithoutTriggerFileResponse = await fetch(`${baseUrl}/trigger`, {
      method: 'POST',
      headers: { Authorization: authorizationHeader },
    });
    assert.equal(runningWithoutTriggerFileResponse.status, 409);
    const runningWithoutTriggerFileBody =
      (await runningWithoutTriggerFileResponse.json()) as Record<string, unknown>;
    assert.equal(runningWithoutTriggerFileBody.reason, 'already_running');

    const statusWhileRunning = (await (await fetch(`${baseUrl}/status`)).json()) as Record<
      string,
      unknown
    >;
    assert.equal(statusWhileRunning.running, true);
    assert.equal(statusWhileRunning.triggerAvailable, false);

    // After run completion, cooldown blocks triggers for 900 seconds from lastRunAt.
    const completedAt = new Date('2026-11-23T12:10:00.000Z');
    recordSyncCompletion(statusFilePath, buildSuccessfulSummary(), completedAt);
    currentSimulatedDate = new Date('2026-11-23T12:15:00.000Z');

    const statusDuringCooldown = (await (await fetch(`${baseUrl}/status`)).json()) as Record<
      string,
      unknown
    >;
    assert.equal(statusDuringCooldown.triggerAvailable, false);
    assert.equal(statusDuringCooldown.triggerCooldownRemainingSeconds, 600);
    assert.equal(statusDuringCooldown.triggerAvailableAt, '2026-11-23T12:25:00.000Z');

    const cooldownResponse = await fetch(`${baseUrl}/trigger`, {
      method: 'POST',
      headers: { Authorization: authorizationHeader },
    });
    assert.equal(cooldownResponse.status, 429);
    assert.equal(cooldownResponse.headers.get('retry-after'), '600');
    const cooldownBody = (await cooldownResponse.json()) as Record<string, unknown>;
    assert.equal(cooldownBody.triggered, false);
    assert.equal(cooldownBody.reason, 'cooldown');
    assert.equal(cooldownBody.cooldownRemainingSeconds, 600);
    assert.equal(cooldownBody.availableAt, '2026-11-23T12:25:00.000Z');

    // Advancing clock past cooldown expiry re-enables triggers.
    currentSimulatedDate = new Date('2026-11-23T12:25:00.000Z');
    const statusAfterCooldown = (await (await fetch(`${baseUrl}/status`)).json()) as Record<
      string,
      unknown
    >;
    assert.equal(statusAfterCooldown.triggerAvailable, true);
    assert.equal(statusAfterCooldown.triggerCooldownRemainingSeconds, 0);
    assert.equal(statusAfterCooldown.triggerAvailableAt, null);

    // Triggering again, then deleting the trigger file before status.json updates exercises post-trigger debounce.
    const reacceptedResponse = await fetch(`${baseUrl}/trigger`, {
      method: 'POST',
      headers: { Authorization: authorizationHeader },
    });
    assert.equal(reacceptedResponse.status, 202);
    fileSystem.rmSync(triggerFilePath, { force: true });

    currentSimulatedDate = new Date('2026-11-23T12:26:00.000Z');
    const debounceCooldownResponse = await fetch(`${baseUrl}/trigger`, {
      method: 'POST',
      headers: { Authorization: authorizationHeader },
    });
    assert.equal(debounceCooldownResponse.status, 429);
    assert.equal(debounceCooldownResponse.headers.get('retry-after'), '840');

    // Failure also starts cooldown from lastRunAt.
    const failedAt = new Date('2026-11-23T13:00:00.000Z');
    recordSyncFailure(statusFilePath, new Error('Backup failed'), 5.0, failedAt);
    currentSimulatedDate = new Date('2026-11-23T13:02:00.000Z');
    const failureCooldownResponse = await fetch(`${baseUrl}/trigger`, {
      method: 'POST',
      headers: { Authorization: authorizationHeader },
    });
    assert.equal(failureCooldownResponse.status, 429);
    assert.equal(failureCooldownResponse.headers.get('retry-after'), '780');
  });

  it('enforces cooldown after scheduled runs, supports zero cooldown, unauthenticated opt-out, concurrency, and write failures', async () => {
    // 1. Scheduled completion recorded before any HTTP trigger still triggers cooldown.
    const scheduledTriggerFilePath = path.join(
      temporaryRootDirectory,
      'scheduled-trigger',
      'backup.trigger',
    );
    const scheduledCompletedAt = new Date('2026-11-23T12:00:00.000Z');
    recordSyncCompletion(statusFilePath, buildSuccessfulSummary(), scheduledCompletedAt);
    currentSimulatedDate = new Date('2026-11-23T12:01:00.000Z');

    serverHandle = await startStatusServer({
      statusFilePath,
      host: '127.0.0.1',
      port: 0,
      maxAgeHours: 26,
      triggerFilePath: scheduledTriggerFilePath,
      triggerCooldownSeconds: 120,
      nowProvider: () => currentSimulatedDate,
    });
    let baseUrl = `http://127.0.0.1:${serverHandle.port}`;

    // Unauthenticated opt-out permits POST /trigger without Authorization header (blocked here by scheduled cooldown).
    const scheduledCooldownResponse = await fetch(`${baseUrl}/trigger`, { method: 'POST' });
    assert.equal(scheduledCooldownResponse.status, 429);
    assert.equal(scheduledCooldownResponse.headers.get('retry-after'), '60');

    // Advancing past scheduled cooldown permits simultaneous concurrent triggers -> exactly one 202 and one 409.
    currentSimulatedDate = new Date('2026-11-23T12:02:01.000Z');
    const [firstConcurrentResponse, secondConcurrentResponse] = await Promise.all([
      fetch(`${baseUrl}/trigger`, { method: 'POST' }),
      fetch(`${baseUrl}/trigger`, { method: 'POST' }),
    ]);
    const concurrentStatusCodes = [
      firstConcurrentResponse.status,
      secondConcurrentResponse.status,
    ].sort((firstCode, secondCode) => firstCode - secondCode);
    assert.deepEqual(concurrentStatusCodes, [202, 409]);
    await serverHandle.close();

    // 2. triggerCooldownSeconds=0 disables post-run cooldown while preserving running & pending guards.
    const zeroCooldownTriggerFilePath = path.join(
      temporaryRootDirectory,
      'zero-cooldown',
      'backup.trigger',
    );
    recordSyncCompletion(statusFilePath, buildSuccessfulSummary(), currentSimulatedDate);

    serverHandle = await startStatusServer({
      statusFilePath,
      host: '127.0.0.1',
      port: 0,
      maxAgeHours: 26,
      triggerFilePath: zeroCooldownTriggerFilePath,
      triggerCooldownSeconds: 0,
      nowProvider: () => currentSimulatedDate,
    });
    baseUrl = `http://127.0.0.1:${serverHandle.port}`;

    const zeroCooldownAcceptedResponse = await fetch(`${baseUrl}/trigger`, { method: 'POST' });
    assert.equal(zeroCooldownAcceptedResponse.status, 202);
    const zeroCooldownPendingResponse = await fetch(`${baseUrl}/trigger`, { method: 'POST' });
    assert.equal(zeroCooldownPendingResponse.status, 409);

    fileSystem.rmSync(zeroCooldownTriggerFilePath, { force: true });
    markSyncRunStarted(statusFilePath, currentSimulatedDate);
    const zeroCooldownRunningResponse = await fetch(`${baseUrl}/trigger`, { method: 'POST' });
    assert.equal(zeroCooldownRunningResponse.status, 409);
    await serverHandle.close();

    // 3. Unwritable trigger file path returns 500 trigger_write_failed without leaking paths or starting cooldown.
    const blockingRegularFilePath = path.join(temporaryRootDirectory, 'not-a-directory');
    fileSystem.writeFileSync(blockingRegularFilePath, 'occupied', 'utf8');
    const brokenTriggerFilePath = path.join(blockingRegularFilePath, 'backup.trigger');
    const freshStatusFilePath = path.join(temporaryRootDirectory, 'fresh-status.json');
    const serverLogs: string[] = [];

    serverHandle = await startStatusServer({
      statusFilePath: freshStatusFilePath,
      host: '127.0.0.1',
      port: 0,
      maxAgeHours: 26,
      triggerFilePath: brokenTriggerFilePath,
      triggerCooldownSeconds: 900,
      nowProvider: () => currentSimulatedDate,
      log: (message) => {
        serverLogs.push(message);
      },
    });
    baseUrl = `http://127.0.0.1:${serverHandle.port}`;

    const writeErrorResponse = await fetch(`${baseUrl}/trigger`, { method: 'POST' });
    assert.equal(writeErrorResponse.status, 500);
    const writeErrorRawText = await writeErrorResponse.text();
    assert.equal(writeErrorRawText.includes(temporaryRootDirectory), false);
    const writeErrorBody = JSON.parse(writeErrorRawText) as Record<string, unknown>;
    assert.equal(writeErrorBody.triggered, false);
    assert.equal(writeErrorBody.reason, 'trigger_write_failed');
    assert.ok(serverLogs.some((entry) => entry.includes('Failed to write backup trigger file:')));

    const statusAfterFailedWrite = (await (await fetch(`${baseUrl}/status`)).json()) as Record<
      string,
      unknown
    >;
    assert.equal(statusAfterFailedWrite.triggerAvailable, true);
    assert.equal(statusAfterFailedWrite.triggerCooldownRemainingSeconds, 0);
  });
});
