import assert from 'node:assert/strict';
import * as fileSystem from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  createDefaultPersistedRunStatus,
  evaluateRunStatus,
  loadPersistedRunStatus,
  markSyncRunStarted,
  recordSyncCompletion,
  recordSyncFailure,
  sanitizeStatusErrorMessage,
} from '../src/runStatus.ts';
import type { OverallSyncSummary } from '../src/types.ts';

function buildOverallSyncSummary(overrides: Partial<OverallSyncSummary> = {}): OverallSyncSummary {
  return {
    dryRun: false,
    usedIncrementalEvents: true,
    eventsProcessedCount: 3,
    mappingSummaries: [
      {
        localDirectory: '/local/sensitive/path',
        remoteDirectory: '/Paperless/Export',
        newFilesCount: 2,
        updatedFilesCount: 1,
        movedOrRenamedFilesCount: 4,
        unchangedFilesCount: 100,
        trashedFilesCount: 1,
        trashedEmptyFoldersCount: 0,
        failedTrashCount: 0,
        bytesTransferred: 4096,
        bytesSavedByMoves: 8192,
        durationSeconds: 12.345,
      },
    ],
    totalNewFilesCount: 2,
    totalUpdatedFilesCount: 1,
    totalMovedOrRenamedFilesCount: 4,
    totalUnchangedFilesCount: 100,
    totalTrashedFilesCount: 1,
    totalTrashedEmptyFoldersCount: 0,
    totalFailedTrashCount: 0,
    totalBytesTransferred: 4096,
    totalBytesSavedByMoves: 8192,
    totalDurationSeconds: 12.345,
    ...overrides,
  };
}

describe('runStatus persistence and evaluation', () => {
  let temporaryRootDirectory = '';
  let statusFilePath = '';

  beforeEach(() => {
    temporaryRootDirectory = fileSystem.mkdtempSync(
      path.join(os.tmpdir(), 'proton-backup-run-status-test-'),
    );
    statusFilePath = path.join(temporaryRootDirectory, 'nested', 'status.json');
  });

  afterEach(() => {
    fileSystem.rmSync(temporaryRootDirectory, { recursive: true, force: true });
  });

  it('sanitizes control characters, bearer tokens, URL credentials, emails, empty messages, and long errors', () => {
    assert.equal(sanitizeStatusErrorMessage('   \n\t  '), 'Unknown error');
    assert.equal(
      sanitizeStatusErrorMessage(
        'Request failed:\nBearer abc.def_123+xyz= for https://alice:s3cr3t@example.com/path as alice@example.com',
      ),
      'Request failed: Bearer [REDACTED] for https://[REDACTED]@example.com/path as [REDACTED_EMAIL]',
    );

    const longInput = 'x'.repeat(650);
    const sanitizedLongOutput = sanitizeStatusErrorMessage(longInput);
    assert.equal(sanitizedLongOutput.length, 500);
    assert.ok(sanitizedLongOutput.endsWith('...'));
  });

  it('evaluates missing status.json as never_run, overdue, problem=true, and healthy=false', () => {
    const evaluationTime = new Date('2026-11-23T12:00:00.000Z');
    const evaluatedStatus = evaluateRunStatus(statusFilePath, 26, evaluationTime);

    assert.equal(evaluatedStatus.status, 'never_run');
    assert.equal(evaluatedStatus.running, false);
    assert.equal(evaluatedStatus.lastRunAt, null);
    assert.equal(evaluatedStatus.lastSuccessAt, null);
    assert.equal(evaluatedStatus.ageHours, null);
    assert.equal(evaluatedStatus.overdue, true);
    assert.equal(evaluatedStatus.problem, true);
    assert.equal(evaluatedStatus.healthy, false);
    assert.equal(evaluatedStatus.checkedAt, evaluationTime.toISOString());
    assert.equal(evaluatedStatus.maxAgeHours, 26);
  });

  it('reports parse failures cleanly on corrupted JSON status files', () => {
    fileSystem.mkdirSync(path.dirname(statusFilePath), { recursive: true });
    fileSystem.writeFileSync(statusFilePath, '{not valid json', 'utf8');

    const loaded = loadPersistedRunStatus(statusFilePath);
    assert.equal(loaded.status.status, 'error');
    assert.equal(loaded.status.errorMessage, 'Status file could not be parsed');
    assert.ok(loaded.parseError && loaded.parseError.length > 0);

    const evaluatedStatus = evaluateRunStatus(statusFilePath, 26, new Date('2026-11-23T12:00:00.000Z'));
    assert.equal(evaluatedStatus.status, 'error');
    assert.equal(evaluatedStatus.problem, true);
    assert.equal(evaluatedStatus.healthy, false);
  });

  it('tracks start, completion, warning, failure, and overdue states without exposing paths or filenames', () => {
    const firstCompletedAt = new Date('2026-11-23T02:00:00.000Z');
    const completedStatus = recordSyncCompletion(
      statusFilePath,
      buildOverallSyncSummary(),
      firstCompletedAt,
    );

    assert.equal(completedStatus.status, 'ok');
    assert.equal(completedStatus.running, false);
    assert.equal(completedStatus.lastSuccessAt, firstCompletedAt.toISOString());
    assert.equal(completedStatus.durationSeconds, 12.35);
    assert.equal(completedStatus.errorMessage, null);
    assert.equal(completedStatus.summary?.mappingsCount, 1);
    assert.equal(completedStatus.summary?.totalNewFilesCount, 2);

    const serializedOnDisk = fileSystem.readFileSync(statusFilePath, 'utf8');
    assert.equal(serializedOnDisk.includes('/local/sensitive/path'), false);
    assert.equal(serializedOnDisk.includes('/Paperless/Export'), false);

    // Starting a new run preserves the previous healthy status and lastSuccessAt until finished.
    const startedAt = new Date('2026-11-23T10:00:00.000Z');
    const startedStatus = markSyncRunStarted(statusFilePath, startedAt);
    assert.equal(startedStatus.running, true);
    assert.equal(startedStatus.currentRunStartedAt, startedAt.toISOString());
    assert.equal(startedStatus.status, 'ok');
    assert.equal(startedStatus.lastSuccessAt, firstCompletedAt.toISOString());

    const whileRunningEvaluated = evaluateRunStatus(
      statusFilePath,
      26,
      new Date('2026-11-23T10:05:00.000Z'),
    );
    assert.equal(whileRunningEvaluated.running, true);
    assert.equal(whileRunningEvaluated.overdue, false);
    assert.equal(whileRunningEvaluated.problem, false);
    assert.equal(whileRunningEvaluated.healthy, true);
    assert.equal(whileRunningEvaluated.ageHours, 8.08);

    // Partial trash failures raise status='warning' and problem=true while updating lastSuccessAt.
    const warningCompletedAt = new Date('2026-11-23T11:00:00.000Z');
    const warningStatus = recordSyncCompletion(
      statusFilePath,
      buildOverallSyncSummary({ totalFailedTrashCount: 2 }),
      warningCompletedAt,
    );
    assert.equal(warningStatus.status, 'warning');
    assert.equal(warningStatus.lastSuccessAt, warningCompletedAt.toISOString());
    assert.match(warningStatus.errorMessage ?? '', /Failed to move 2 obsolete item\(s\) to Trash/);

    const evaluatedWarning = evaluateRunStatus(
      statusFilePath,
      26,
      new Date('2026-11-23T12:00:00.000Z'),
    );
    assert.equal(evaluatedWarning.overdue, false);
    assert.equal(evaluatedWarning.problem, true);
    assert.equal(evaluatedWarning.healthy, false);

    // Recording an error preserves lastSuccessAt from the previous completion.
    const failedAt = new Date('2026-11-23T13:00:00.000Z');
    const failedStatus = recordSyncFailure(
      statusFilePath,
      new Error('Auth failed for user@example.com with Bearer secret_token_123'),
      4.567,
      failedAt,
    );
    assert.equal(failedStatus.status, 'error');
    assert.equal(failedStatus.running, false);
    assert.equal(failedStatus.lastRunAt, failedAt.toISOString());
    assert.equal(failedStatus.lastSuccessAt, warningCompletedAt.toISOString());
    assert.equal(failedStatus.durationSeconds, 4.57);
    assert.equal(failedStatus.summary, null);
    assert.equal(failedStatus.errorMessage, 'Auth failed for [REDACTED_EMAIL] with Bearer [REDACTED]');

    // Overdue evaluation triggers overdue=true and problem=true even when status is 'ok'.
    recordSyncCompletion(statusFilePath, buildOverallSyncSummary(), firstCompletedAt);
    const overdueStatus = evaluateRunStatus(
      statusFilePath,
      26,
      new Date('2026-11-24T04:01:00.000Z'),
    );
    assert.equal(overdueStatus.status, 'ok');
    assert.equal(overdueStatus.ageHours, 26.02);
    assert.equal(overdueStatus.overdue, true);
    assert.equal(overdueStatus.problem, true);
    assert.equal(overdueStatus.healthy, false);

    // Default helper returns expected initial shape.
    assert.equal(createDefaultPersistedRunStatus().status, 'never_run');
  });
});
