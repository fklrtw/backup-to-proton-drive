import * as nodeCrypto from 'node:crypto';
import * as fileSystem from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';

import { evaluateRunStatus } from './runStatus.ts';
import type {
  BackupTriggerResponse,
  EvaluatedRunStatus,
  StatusServerPayload,
  TriggerAvailabilityStatus,
} from './types.ts';

/** Default cooldown duration in seconds after a run finishes or trigger is accepted (15 minutes). */
export const DEFAULT_STATUS_TRIGGER_COOLDOWN_SECONDS = 900;

/** Maximum configurable trigger cooldown period in seconds (7 days). */
export const MAXIMUM_STATUS_TRIGGER_COOLDOWN_SECONDS = 604_800;

/** Minimum required token length in bytes for `STATUS_TRIGGER_TOKEN_FILE`. */
export const MINIMUM_TRIGGER_TOKEN_BYTE_LENGTH = 32;

/**
 * Configuration options for {@link startStatusServer}.
 */
export interface StatusServerOptions {
  /** Path to the persisted `status.json` telemetry file. */
  statusFilePath: string;
  /** Host interface to bind (for example `0.0.0.0` or `127.0.0.1`). */
  host: string;
  /** TCP port to bind (`0` selects an ephemeral OS-assigned port). */
  port: number;
  /** Maximum permitted hours since `lastSuccessAt` before flagging `overdue: true`. */
  maxAgeHours: number;
  /** Optional path to a trigger file enabling `POST /trigger` (disabled when omitted). */
  triggerFilePath?: string | undefined;
  /** Optional bearer token bytes required by `POST /trigger` (`Authorization: Bearer <token>`). */
  triggerToken?: Buffer | undefined;
  /** Minimum cooldown in seconds after `lastRunAt` or trigger acceptance before another trigger is allowed. */
  triggerCooldownSeconds?: number | undefined;
  /** Optional clock override primarily used by unit tests. */
  nowProvider?: (() => Date) | undefined;
  /** Optional logger invoked when the server starts or handles requests. */
  log?: ((message: string) => void) | undefined;
}

/**
 * Running handle returned by {@link startStatusServer}.
 */
export interface StatusServerHandle {
  /** Underlying Node HTTP server instance. */
  server: http.Server;
  /** Bound host address. */
  host: string;
  /** Actual bound TCP port (useful when started with port `0`). */
  port: number;
  /** Gracefully closes the HTTP listener and any open keep-alive sockets. */
  close(): Promise<void>;
}

const COMMON_JSON_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

const BEARER_REALM_CHALLENGE_HEADER = 'Bearer realm="backup-to-proton-drive"';
const MILLISECONDS_PER_SECOND = 1_000;

/**
 * Normalizes and validates raw trigger bearer token material read from `STATUS_TRIGGER_TOKEN_FILE`,
 * stripping a single trailing newline, rejecting embedded whitespace or control characters, and
 * enforcing a minimum length of {@link MINIMUM_TRIGGER_TOKEN_BYTE_LENGTH} bytes.
 *
 * @param rawTokenText - Raw UTF-8 text read from the trigger token secret file.
 * @param sourceDescription - Descriptive file path or flag label included in error messages.
 * @returns Validated UTF-8 bearer token byte buffer.
 */
export function validateTriggerTokenMaterial(
  rawTokenText: string,
  sourceDescription: string,
): Buffer {
  const normalizedTokenText = rawTokenText.replace(/\r?\n$/, '');

  if (/[\u0000-\u0020\u007F]/.test(normalizedTokenText)) {
    throw new Error(
      `Trigger token in ${sourceDescription} must be a single-line secret without embedded spaces, tabs, newlines, or control characters.`,
    );
  }

  const tokenMaterialBuffer = Buffer.from(normalizedTokenText, 'utf8');
  if (tokenMaterialBuffer.length < MINIMUM_TRIGGER_TOKEN_BYTE_LENGTH) {
    throw new Error(
      `Trigger token in ${sourceDescription} is too short (${tokenMaterialBuffer.length} bytes; minimum ${MINIMUM_TRIGGER_TOKEN_BYTE_LENGTH} bytes required). Generate one with: openssl rand -base64 32`,
    );
  }

  return tokenMaterialBuffer;
}

/**
 * Verifies an HTTP `Authorization` header against the configured trigger bearer token using
 * SHA-256 digests and `crypto.timingSafeEqual` so neither token bytes nor token length leak
 * through timing side channels.
 *
 * @param authorizationHeader - Incoming HTTP `Authorization` header value.
 * @param expectedToken - Expected bearer token byte buffer.
 * @returns `true` if the header carries a valid matching `Bearer` token.
 */
export function verifyBearerAuthorizationHeader(
  authorizationHeader: string | undefined,
  expectedToken: Buffer,
): boolean {
  if (typeof authorizationHeader !== 'string') {
    return false;
  }

  const bearerMatch = /^Bearer[ \t]+([^\s]+)$/i.exec(authorizationHeader);
  if (!bearerMatch) {
    return false;
  }

  const providedTokenText = bearerMatch[1];
  if (providedTokenText === undefined || providedTokenText.length === 0) {
    return false;
  }

  const providedTokenDigest = nodeCrypto
    .createHash('sha256')
    .update(Buffer.from(providedTokenText, 'utf8'))
    .digest();
  const expectedTokenDigest = nodeCrypto.createHash('sha256').update(expectedToken).digest();

  return nodeCrypto.timingSafeEqual(providedTokenDigest, expectedTokenDigest);
}

/**
 * Checks whether a pending backup trigger file currently exists on disk.
 * Uses `lstatSync` so even broken symlinks or non-regular entries block duplicate triggers safely.
 *
 * @param triggerFilePath - Configured trigger file path.
 * @returns `true` when an entry already exists at `triggerFilePath`.
 */
function checkTriggerFileExists(triggerFilePath: string): boolean {
  try {
    fileSystem.lstatSync(triggerFilePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parses a nullable ISO-8601 timestamp string into epoch milliseconds.
 *
 * @param isoTimestamp - Nullable ISO-8601 timestamp string.
 * @returns Finite epoch milliseconds, or `null` when absent or unparseable.
 */
function parseIsoTimestampMilliseconds(isoTimestamp: string | null): number | null {
  if (isoTimestamp === null) {
    return null;
  }

  const parsedMilliseconds = Date.parse(isoTimestamp);
  return Number.isNaN(parsedMilliseconds) ? null : parsedMilliseconds;
}

/**
 * Writes a JSON (or empty `HEAD`) response with standardized cache and security headers.
 *
 * @param response - Node HTTP server response stream.
 * @param requestMethod - HTTP method used by the client.
 * @param statusCode - HTTP response status code.
 * @param payload - Serializable JSON body object.
 * @param additionalHeaders - Optional extra HTTP headers (such as `Allow` on `405`).
 */
function sendJsonResponse(
  response: http.ServerResponse,
  requestMethod: string,
  statusCode: number,
  payload: unknown,
  additionalHeaders: Record<string, string> = {},
): void {
  const serializedBody = `${JSON.stringify(payload, null, 2)}\n`;
  const headers: Record<string, string | number> = {
    ...COMMON_JSON_RESPONSE_HEADERS,
    ...additionalHeaders,
    'Content-Length': Buffer.byteLength(serializedBody, 'utf8'),
  };

  response.writeHead(statusCode, headers);
  if (requestMethod === 'HEAD') {
    response.end();
    return;
  }

  response.end(serializedBody);
}

/**
 * Starts a lightweight HTTP telemetry server exposing backup run status, health checks,
 * and an optional authenticated on-demand trigger endpoint for LAN tools such as Home Assistant.
 *
 * Endpoints:
 * - `GET` / `HEAD` `/status` and `/status.json`: Always responds `200 OK` with evaluated JSON
 *   (`problem`, `healthy`, `overdue`, `ageHours`, timestamps, aggregate counts, and trigger availability)
 *   so pollers always parse attributes cleanly.
 * - `GET` / `HEAD` `/health`: Responds `200 OK` when `healthy === true` and `503 Service Unavailable`
 *   when `problem === true`.
 * - `POST` `/trigger` (when `triggerFilePath` is configured): Validates optional bearer token,
 *   enforces running, pending-trigger, and cooldown guards, and atomically creates the trigger file
 *   (`202 Accepted` on creation, `401` on invalid auth, `409` if running/pending, `429` during cooldown).
 *
 * @param options - Server binding, status evaluation, and optional trigger options.
 * @returns Promise resolving to the active {@link StatusServerHandle} once listening.
 */
export async function startStatusServer(options: StatusServerOptions): Promise<StatusServerHandle> {
  const nowProvider = options.nowProvider ?? (() => new Date());
  const triggerFilePath = options.triggerFilePath;
  const triggerEnabled = triggerFilePath !== undefined;
  const triggerCooldownSeconds =
    options.triggerCooldownSeconds ?? DEFAULT_STATUS_TRIGGER_COOLDOWN_SECONDS;
  let lastTriggerAcceptedAtMilliseconds: number | null = null;

  /**
   * Computes current trigger availability, pending status, and cooldown metrics relative to
   * `evaluatedStatus` and `currentDate`.
   */
  const evaluateTriggerAvailability = (
    evaluatedStatus: EvaluatedRunStatus,
    currentDate: Date,
  ): TriggerAvailabilityStatus => {
    if (!triggerEnabled || triggerFilePath === undefined) {
      return {
        triggerEnabled: false,
        triggerAvailable: false,
        triggerPending: false,
        triggerCooldownSeconds: null,
        triggerCooldownRemainingSeconds: null,
        triggerAvailableAt: null,
      };
    }

    const triggerPending = checkTriggerFileExists(triggerFilePath);
    if (evaluatedStatus.running || triggerPending) {
      return {
        triggerEnabled: true,
        triggerAvailable: false,
        triggerPending,
        triggerCooldownSeconds,
        triggerCooldownRemainingSeconds: null,
        triggerAvailableAt: null,
      };
    }

    const lastRunAtMilliseconds = parseIsoTimestampMilliseconds(evaluatedStatus.lastRunAt);
    let cooldownAnchorMilliseconds: number | null = null;
    if (lastRunAtMilliseconds !== null && lastTriggerAcceptedAtMilliseconds !== null) {
      cooldownAnchorMilliseconds = Math.max(
        lastRunAtMilliseconds,
        lastTriggerAcceptedAtMilliseconds,
      );
    } else {
      cooldownAnchorMilliseconds = lastRunAtMilliseconds ?? lastTriggerAcceptedAtMilliseconds;
    }

    if (triggerCooldownSeconds > 0 && cooldownAnchorMilliseconds !== null) {
      const cooldownExpiresAtMilliseconds =
        cooldownAnchorMilliseconds + triggerCooldownSeconds * MILLISECONDS_PER_SECOND;
      const remainingMilliseconds = cooldownExpiresAtMilliseconds - currentDate.getTime();
      if (remainingMilliseconds > 0) {
        return {
          triggerEnabled: true,
          triggerAvailable: false,
          triggerPending: false,
          triggerCooldownSeconds,
          triggerCooldownRemainingSeconds: Math.ceil(
            remainingMilliseconds / MILLISECONDS_PER_SECOND,
          ),
          triggerAvailableAt: new Date(cooldownExpiresAtMilliseconds).toISOString(),
        };
      }
    }

    return {
      triggerEnabled: true,
      triggerAvailable: true,
      triggerPending: false,
      triggerCooldownSeconds,
      triggerCooldownRemainingSeconds: 0,
      triggerAvailableAt: null,
    };
  };

  /**
   * Builds a combined {@link StatusServerPayload} evaluated at `nowProvider()`.
   */
  const buildStatusPayload = (): StatusServerPayload => {
    const currentDate = nowProvider();
    const evaluatedStatus = evaluateRunStatus(
      options.statusFilePath,
      options.maxAgeHours,
      currentDate,
    );
    const triggerAvailability = evaluateTriggerAvailability(evaluatedStatus, currentDate);
    return {
      ...evaluatedStatus,
      ...triggerAvailability,
    };
  };

  const server = http.createServer((request, response) => {
    const requestMethod = (request.method ?? 'GET').toUpperCase();

    let requestPathname = '/';
    try {
      const parsedRequestUrl = new URL(request.url ?? '/', 'http://localhost');
      requestPathname = parsedRequestUrl.pathname;
    } catch {
      sendJsonResponse(response, requestMethod, 400, { error: 'Invalid request URL' });
      return;
    }

    if (requestPathname === '/status' || requestPathname === '/status.json') {
      if (requestMethod !== 'GET' && requestMethod !== 'HEAD') {
        sendJsonResponse(
          response,
          requestMethod,
          405,
          { error: 'Method not allowed' },
          { Allow: 'GET, HEAD' },
        );
        return;
      }

      const statusPayload = buildStatusPayload();
      sendJsonResponse(response, requestMethod, 200, statusPayload);
      return;
    }

    if (requestPathname === '/health') {
      if (requestMethod !== 'GET' && requestMethod !== 'HEAD') {
        sendJsonResponse(
          response,
          requestMethod,
          405,
          { error: 'Method not allowed' },
          { Allow: 'GET, HEAD' },
        );
        return;
      }

      const statusPayload = buildStatusPayload();
      const httpStatusCode = statusPayload.healthy ? 200 : 503;
      sendJsonResponse(response, requestMethod, httpStatusCode, statusPayload);
      return;
    }

    if (requestPathname === '/trigger' && triggerEnabled && triggerFilePath !== undefined) {
      // Drain any unsolicited request body so keep-alive connections stay clean without buffering.
      request.resume();

      if (requestMethod !== 'POST') {
        sendJsonResponse(
          response,
          requestMethod,
          405,
          { error: 'Method not allowed' },
          { Allow: 'POST' },
        );
        return;
      }

      if (
        options.triggerToken !== undefined &&
        !verifyBearerAuthorizationHeader(request.headers.authorization, options.triggerToken)
      ) {
        sendJsonResponse(
          response,
          requestMethod,
          401,
          { error: 'Unauthorized' },
          { 'WWW-Authenticate': BEARER_REALM_CHALLENGE_HEADER },
        );
        return;
      }

      const currentDate = nowProvider();
      const evaluatedStatus = evaluateRunStatus(
        options.statusFilePath,
        options.maxAgeHours,
        currentDate,
      );
      const triggerStatus = evaluateTriggerAvailability(evaluatedStatus, currentDate);

      if (evaluatedStatus.running) {
        const runningResponse: BackupTriggerResponse = {
          triggered: false,
          reason: 'already_running',
          message: 'A backup is already running.',
          running: true,
          currentRunStartedAt: evaluatedStatus.currentRunStartedAt,
          triggerPending: triggerStatus.triggerPending,
          cooldownSeconds: triggerCooldownSeconds,
          cooldownRemainingSeconds: null,
          availableAt: null,
        };
        sendJsonResponse(response, requestMethod, 409, runningResponse);
        return;
      }

      if (triggerStatus.triggerPending) {
        const pendingResponse: BackupTriggerResponse = {
          triggered: false,
          reason: 'trigger_pending',
          message: 'A backup trigger request is already pending.',
          running: false,
          currentRunStartedAt: null,
          triggerPending: true,
          cooldownSeconds: triggerCooldownSeconds,
          cooldownRemainingSeconds: null,
          availableAt: null,
        };
        sendJsonResponse(response, requestMethod, 409, pendingResponse);
        return;
      }

      if (
        triggerStatus.triggerCooldownRemainingSeconds !== null &&
        triggerStatus.triggerCooldownRemainingSeconds > 0
      ) {
        const cooldownResponse: BackupTriggerResponse = {
          triggered: false,
          reason: 'cooldown',
          message: `Backup trigger is in cooldown. Try again in ${triggerStatus.triggerCooldownRemainingSeconds} second(s).`,
          running: false,
          currentRunStartedAt: null,
          triggerPending: false,
          cooldownSeconds: triggerCooldownSeconds,
          cooldownRemainingSeconds: triggerStatus.triggerCooldownRemainingSeconds,
          availableAt: triggerStatus.triggerAvailableAt,
        };
        sendJsonResponse(response, requestMethod, 429, cooldownResponse, {
          'Retry-After': String(triggerStatus.triggerCooldownRemainingSeconds),
        });
        return;
      }

      const requestedAtIso = currentDate.toISOString();
      const triggerFilePayload = `${JSON.stringify({ requestedAt: requestedAtIso }, null, 2)}\n`;

      try {
        const triggerDirectoryPath = path.dirname(triggerFilePath);
        if (!fileSystem.existsSync(triggerDirectoryPath)) {
          fileSystem.mkdirSync(triggerDirectoryPath, { recursive: true });
        }
        fileSystem.writeFileSync(triggerFilePath, triggerFilePayload, {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o644,
        });
      } catch (writeError) {
        const nodeError = writeError as NodeJS.ErrnoException;
        if (nodeError.code === 'EEXIST') {
          const pendingRaceResponse: BackupTriggerResponse = {
            triggered: false,
            reason: 'trigger_pending',
            message: 'A backup trigger request is already pending.',
            running: false,
            currentRunStartedAt: null,
            triggerPending: true,
            cooldownSeconds: triggerCooldownSeconds,
            cooldownRemainingSeconds: null,
            availableAt: null,
          };
          sendJsonResponse(response, requestMethod, 409, pendingRaceResponse);
          return;
        }

        const errorDetail =
          writeError instanceof Error ? writeError.message : String(writeError);
        options.log?.(`Failed to write backup trigger file: ${errorDetail}`);
        const writeErrorResponse: BackupTriggerResponse = {
          triggered: false,
          reason: 'trigger_write_failed',
          message: 'Failed to write backup trigger file.',
          running: false,
          currentRunStartedAt: null,
          triggerPending: false,
          cooldownSeconds: triggerCooldownSeconds,
          cooldownRemainingSeconds: null,
          availableAt: null,
        };
        sendJsonResponse(response, requestMethod, 500, writeErrorResponse);
        return;
      }

      lastTriggerAcceptedAtMilliseconds = currentDate.getTime();
      options.log?.(`Accepted backup trigger request at ${requestedAtIso}`);
      const acceptedResponse: BackupTriggerResponse = {
        triggered: true,
        reason: 'accepted',
        message: 'Backup trigger accepted.',
        requestedAt: requestedAtIso,
        running: false,
        currentRunStartedAt: null,
        triggerPending: true,
        cooldownSeconds: triggerCooldownSeconds,
        cooldownRemainingSeconds: null,
        availableAt: null,
      };
      sendJsonResponse(response, requestMethod, 202, acceptedResponse);
      return;
    }

    sendJsonResponse(response, requestMethod, 404, { error: 'Not found' });
  });

  await new Promise<void>((resolve, reject) => {
    const onStartupError = (startupError: Error) => {
      server.removeListener('listening', onListening);
      reject(startupError);
    };

    const onListening = () => {
      server.removeListener('error', onStartupError);
      resolve();
    };

    server.once('error', onStartupError);
    server.once('listening', onListening);
    server.listen(options.port, options.host);
  });

  const serverAddress = server.address() as AddressInfo | null;
  const boundPort = serverAddress ? serverAddress.port : options.port;
  const boundHost = serverAddress ? serverAddress.address : options.host;

  const triggerConfigurationSummary = triggerEnabled
    ? `trigger=enabled, triggerAuthentication=${options.triggerToken ? 'bearer-token' : 'unauthenticated'}, triggerCooldownSeconds=${triggerCooldownSeconds}`
    : 'trigger=disabled';

  options.log?.(
    `Status server listening on http://${boundHost}:${boundPort} (statusFile=${options.statusFilePath}, maxAgeHours=${options.maxAgeHours}, ${triggerConfigurationSummary})`,
  );

  return {
    server,
    host: boundHost,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        server.close((closeError) => {
          if (closeError) {
            reject(closeError);
            return;
          }
          resolve();
        });
      }),
  };
}
