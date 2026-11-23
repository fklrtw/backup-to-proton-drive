import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  EvaluatedRunStatus,
  OverallSyncSummary,
  PersistedRunStatus,
  PersistedRunStatusSummary,
  RunStatusState,
} from './types.ts';

/** Default maximum allowed age (in hours) since `lastSuccessAt` before a backup is overdue. */
export const DEFAULT_STATUS_MAX_AGE_HOURS = 26;

/** Default network interface bound by `status-server`. */
export const DEFAULT_STATUS_SERVER_HOST = '0.0.0.0';

/** Default TCP port bound by `status-server`. */
export const DEFAULT_STATUS_SERVER_PORT = 9108;

const MAXIMUM_STATUS_ERROR_MESSAGE_LENGTH = 500;
const MILLISECONDS_PER_HOUR = 3_600_000;
const VALID_RUN_STATUS_STATES: ReadonlySet<RunStatusState> = new Set([
  'ok',
  'warning',
  'error',
  'never_run',
]);

/**
 * Sanitizes an error message before persisting it to unauthenticated plaintext `status.json`.
 * Strips control characters, redacts bearer tokens, URL credentials, and email addresses,
 * and caps the length to keep Home Assistant entity attributes compact.
 *
 * @param rawErrorMessage - Unsanitized error description.
 * @returns Single-line redacted error description suitable for unauthenticated LAN status polling.
 */
export function sanitizeStatusErrorMessage(rawErrorMessage: string): string {
  const singleLineMessage = rawErrorMessage
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (singleLineMessage.length === 0) {
    return 'Unknown error';
  }

  const redactedMessage = singleLineMessage
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/:\/\/[^/\s:@]+:[^/\s@]+@/g, '://[REDACTED]@')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]')
    .trim();

  if (redactedMessage.length === 0) {
    return 'Unknown error';
  }

  if (redactedMessage.length > MAXIMUM_STATUS_ERROR_MESSAGE_LENGTH) {
    return `${redactedMessage.slice(0, MAXIMUM_STATUS_ERROR_MESSAGE_LENGTH - 3)}...`;
  }

  return redactedMessage;
}

/**
 * Builds the default initial run status returned before any live sync has executed.
 *
 * @returns Initial {@link PersistedRunStatus} with `status: 'never_run'`.
 */
export function createDefaultPersistedRunStatus(): PersistedRunStatus {
  return {
    schemaVersion: 1,
    status: 'never_run',
    running: false,
    currentRunStartedAt: null,
    lastRunAt: null,
    lastSuccessAt: null,
    durationSeconds: null,
    errorMessage: null,
    summary: null,
  };
}

/**
 * Validates that a parsed JSON value matches the {@link PersistedRunStatusSummary} contract.
 *
 * @param candidateValue - Parsed `summary` field from disk.
 * @returns Normalized summary object, or `null` if invalid.
 */
function parsePersistedSummary(candidateValue: unknown): PersistedRunStatusSummary | null {
  if (typeof candidateValue !== 'object' || candidateValue === null || Array.isArray(candidateValue)) {
    return null;
  }

  const record = candidateValue as Record<string, unknown>;
  const numericFields: Array<keyof PersistedRunStatusSummary> = [
    'mappingsCount',
    'eventsProcessedCount',
    'totalNewFilesCount',
    'totalUpdatedFilesCount',
    'totalMovedOrRenamedFilesCount',
    'totalUnchangedFilesCount',
    'totalTrashedFilesCount',
    'totalTrashedEmptyFoldersCount',
    'totalFailedTrashCount',
    'totalBytesTransferred',
    'totalBytesSavedByMoves',
  ];

  for (const fieldName of numericFields) {
    const fieldValue = record[fieldName];
    if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue)) {
      return null;
    }
  }

  if (typeof record.usedIncrementalEvents !== 'boolean') {
    return null;
  }

  return {
    mappingsCount: record.mappingsCount as number,
    usedIncrementalEvents: record.usedIncrementalEvents,
    eventsProcessedCount: record.eventsProcessedCount as number,
    totalNewFilesCount: record.totalNewFilesCount as number,
    totalUpdatedFilesCount: record.totalUpdatedFilesCount as number,
    totalMovedOrRenamedFilesCount: record.totalMovedOrRenamedFilesCount as number,
    totalUnchangedFilesCount: record.totalUnchangedFilesCount as number,
    totalTrashedFilesCount: record.totalTrashedFilesCount as number,
    totalTrashedEmptyFoldersCount: record.totalTrashedEmptyFoldersCount as number,
    totalFailedTrashCount: record.totalFailedTrashCount as number,
    totalBytesTransferred: record.totalBytesTransferred as number,
    totalBytesSavedByMoves: record.totalBytesSavedByMoves as number,
  };
}

/**
 * Loads and validates the persisted run status JSON file.
 * Returns `never_run` when the file does not exist yet, and surfaces an explicit error status
 * when the file contains invalid JSON or an incompatible schema.
 *
 * @param statusFilePath - Path to `status.json`.
 * @returns Validated status object along with an optional parse error reason.
 */
export function loadPersistedRunStatus(statusFilePath: string): {
  status: PersistedRunStatus;
  parseError?: string | undefined;
} {
  let rawFileContent: string;
  try {
    rawFileContent = fs.readFileSync(statusFilePath, 'utf8');
  } catch (readError) {
    const nodeError = readError as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return { status: createDefaultPersistedRunStatus() };
    }

    const message = readError instanceof Error ? readError.message : String(readError);
    return {
      status: {
        ...createDefaultPersistedRunStatus(),
        status: 'error',
        errorMessage: sanitizeStatusErrorMessage(`Status file could not be read: ${message}`),
      },
      parseError: message,
    };
  }

  try {
    const parsedValue: unknown = JSON.parse(rawFileContent);
    if (typeof parsedValue !== 'object' || parsedValue === null || Array.isArray(parsedValue)) {
      throw new Error('Top-level JSON value must be an object.');
    }

    const record = parsedValue as Record<string, unknown>;
    if (record.schemaVersion !== 1) {
      throw new Error(`Unsupported status schemaVersion: ${String(record.schemaVersion)}`);
    }

    if (typeof record.status !== 'string' || !VALID_RUN_STATUS_STATES.has(record.status as RunStatusState)) {
      throw new Error(`Invalid status state: ${String(record.status)}`);
    }

    if (typeof record.running !== 'boolean') {
      throw new Error('Field "running" must be a boolean.');
    }

    const isNullableString = (value: unknown): value is string | null =>
      value === null || typeof value === 'string';

    if (
      !isNullableString(record.currentRunStartedAt) ||
      !isNullableString(record.lastRunAt) ||
      !isNullableString(record.lastSuccessAt) ||
      !isNullableString(record.errorMessage)
    ) {
      throw new Error('Timestamp and errorMessage fields must be strings or null.');
    }

    if (
      record.durationSeconds !== null &&
      (typeof record.durationSeconds !== 'number' || !Number.isFinite(record.durationSeconds))
    ) {
      throw new Error('Field "durationSeconds" must be a finite number or null.');
    }

    let parsedSummary: PersistedRunStatusSummary | null = null;
    if (record.summary !== null) {
      parsedSummary = parsePersistedSummary(record.summary);
      if (parsedSummary === null) {
        throw new Error('Field "summary" has an invalid structure.');
      }
    }

    return {
      status: {
        schemaVersion: 1,
        status: record.status as RunStatusState,
        running: record.running,
        currentRunStartedAt: record.currentRunStartedAt,
        lastRunAt: record.lastRunAt,
        lastSuccessAt: record.lastSuccessAt,
        durationSeconds: record.durationSeconds,
        errorMessage: record.errorMessage,
        summary: parsedSummary,
      },
    };
  } catch (parseError) {
    const message = parseError instanceof Error ? parseError.message : String(parseError);
    return {
      status: {
        ...createDefaultPersistedRunStatus(),
        status: 'error',
        errorMessage: 'Status file could not be parsed',
      },
      parseError: message,
    };
  }
}

/**
 * Atomically writes a {@link PersistedRunStatus} payload to disk (`0644`) using a sibling
 * temporary file followed by `rename` so readers (such as `status-server`) never observe partial JSON.
 *
 * @param statusFilePath - Target path for `status.json`.
 * @param runStatus - Validated status payload to persist.
 */
export function savePersistedRunStatus(statusFilePath: string, runStatus: PersistedRunStatus): void {
  const targetDirectory = path.dirname(statusFilePath);
  fs.mkdirSync(targetDirectory, { recursive: true });

  const temporaryFilePath = path.join(
    targetDirectory,
    `.status.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );

  try {
    fs.writeFileSync(temporaryFilePath, `${JSON.stringify(runStatus, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o644,
    });
    fs.renameSync(temporaryFilePath, statusFilePath);
  } catch (writeError) {
    try {
      if (fs.existsSync(temporaryFilePath)) {
        fs.unlinkSync(temporaryFilePath);
      }
    } catch {
      // Best-effort cleanup of failed temporary file write.
    }
    throw writeError;
  }
}

/**
 * Marks a live synchronization run as in-progress without erasing the previous outcome
 * or `lastSuccessAt` timestamp, so Home Assistant does not raise false alerts during uploads.
 *
 * @param statusFilePath - Target `status.json` path.
 * @param startedAt - Start timestamp (defaults to current time).
 * @returns Newly persisted {@link PersistedRunStatus}.
 */
export function markSyncRunStarted(
  statusFilePath: string,
  startedAt: Date = new Date(),
): PersistedRunStatus {
  const loaded = loadPersistedRunStatus(statusFilePath);
  const baseStatus = loaded.parseError ? createDefaultPersistedRunStatus() : loaded.status;

  const updatedStatus: PersistedRunStatus = {
    ...baseStatus,
    running: true,
    currentRunStartedAt: startedAt.toISOString(),
  };

  savePersistedRunStatus(statusFilePath, updatedStatus);
  return updatedStatus;
}

/**
 * Records the completion of a live synchronization run.
 * Updates both `lastRunAt` and `lastSuccessAt`; when one or more obsolete remote items fail
 * to move to Trash (`totalFailedTrashCount > 0`), sets `status: 'warning'` so monitoring
 * surfaces the cleanup issue while reflecting that local data was still uploaded.
 *
 * @param statusFilePath - Target `status.json` path.
 * @param overallSummary - Aggregated metrics produced by `executeSyncRun`.
 * @param completedAt - Completion timestamp (defaults to current time).
 * @returns Newly persisted {@link PersistedRunStatus}.
 */
export function recordSyncCompletion(
  statusFilePath: string,
  overallSummary: OverallSyncSummary,
  completedAt: Date = new Date(),
): PersistedRunStatus {
  const completedAtIso = completedAt.toISOString();
  const hasTrashWarnings = overallSummary.totalFailedTrashCount > 0;

  const persistedSummary: PersistedRunStatusSummary = {
    mappingsCount: overallSummary.mappingSummaries.length,
    usedIncrementalEvents: overallSummary.usedIncrementalEvents,
    eventsProcessedCount: overallSummary.eventsProcessedCount,
    totalNewFilesCount: overallSummary.totalNewFilesCount,
    totalUpdatedFilesCount: overallSummary.totalUpdatedFilesCount,
    totalMovedOrRenamedFilesCount: overallSummary.totalMovedOrRenamedFilesCount,
    totalUnchangedFilesCount: overallSummary.totalUnchangedFilesCount,
    totalTrashedFilesCount: overallSummary.totalTrashedFilesCount,
    totalTrashedEmptyFoldersCount: overallSummary.totalTrashedEmptyFoldersCount,
    totalFailedTrashCount: overallSummary.totalFailedTrashCount,
    totalBytesTransferred: overallSummary.totalBytesTransferred,
    totalBytesSavedByMoves: overallSummary.totalBytesSavedByMoves,
  };

  const completedStatus: PersistedRunStatus = {
    schemaVersion: 1,
    status: hasTrashWarnings ? 'warning' : 'ok',
    running: false,
    currentRunStartedAt: null,
    lastRunAt: completedAtIso,
    lastSuccessAt: completedAtIso,
    durationSeconds: Math.max(0, Number(overallSummary.totalDurationSeconds.toFixed(2))),
    errorMessage: hasTrashWarnings
      ? `Failed to move ${overallSummary.totalFailedTrashCount} obsolete item(s) to Trash`
      : null,
    summary: persistedSummary,
  };

  savePersistedRunStatus(statusFilePath, completedStatus);
  return completedStatus;
}

/**
 * Records a failed synchronization run or an external pre-sync failure reported via `report-failure`.
 * Preserves any previously recorded `lastSuccessAt` timestamp so overdue calculations remain accurate.
 *
 * @param statusFilePath - Target `status.json` path.
 * @param errorOrMessage - Thrown error instance or descriptive failure message.
 * @param durationSeconds - Elapsed duration in seconds when known, or `null`.
 * @param failedAt - Failure timestamp (defaults to current time).
 * @returns Newly persisted {@link PersistedRunStatus}.
 */
export function recordSyncFailure(
  statusFilePath: string,
  errorOrMessage: unknown,
  durationSeconds: number | null = null,
  failedAt: Date = new Date(),
): PersistedRunStatus {
  const loaded = loadPersistedRunStatus(statusFilePath);
  const previousLastSuccessAt = loaded.parseError ? null : loaded.status.lastSuccessAt;

  const rawMessage =
    errorOrMessage instanceof Error ? errorOrMessage.message : String(errorOrMessage);
  const normalizedDuration =
    durationSeconds !== null && Number.isFinite(durationSeconds)
      ? Math.max(0, Number(durationSeconds.toFixed(2)))
      : null;

  const failedStatus: PersistedRunStatus = {
    schemaVersion: 1,
    status: 'error',
    running: false,
    currentRunStartedAt: null,
    lastRunAt: failedAt.toISOString(),
    lastSuccessAt: previousLastSuccessAt,
    durationSeconds: normalizedDuration,
    errorMessage: sanitizeStatusErrorMessage(rawMessage),
    summary: null,
  };

  savePersistedRunStatus(statusFilePath, failedStatus);
  return failedStatus;
}

/**
 * Loads `status.json` and computes live health, staleness (`overdue`), and `problem` flags
 * relative to `currentDate` and `maxAgeHours`.
 *
 * @param statusFilePath - Path to `status.json`.
 * @param maxAgeHours - Maximum permitted hours since `lastSuccessAt` before flagging `overdue`.
 * @param currentDate - Evaluation timestamp (defaults to `new Date()`).
 * @returns Dynamically evaluated status payload exposed by `status-server`.
 */
export function evaluateRunStatus(
  statusFilePath: string,
  maxAgeHours: number,
  currentDate: Date = new Date(),
): EvaluatedRunStatus {
  const loaded = loadPersistedRunStatus(statusFilePath);
  const persistedStatus = loaded.status;

  let ageHours: number | null = null;
  if (persistedStatus.lastSuccessAt !== null) {
    const lastSuccessMs = Date.parse(persistedStatus.lastSuccessAt);
    if (!Number.isNaN(lastSuccessMs)) {
      const elapsedHours = (currentDate.getTime() - lastSuccessMs) / MILLISECONDS_PER_HOUR;
      ageHours = Math.max(0, Number(elapsedHours.toFixed(2)));
    }
  }

  const overdue = ageHours === null || ageHours > maxAgeHours;
  const problem = persistedStatus.status !== 'ok' || overdue;
  const healthy = !problem;

  return {
    ...persistedStatus,
    checkedAt: currentDate.toISOString(),
    maxAgeHours,
    ageHours,
    overdue,
    problem,
    healthy,
  };
}
