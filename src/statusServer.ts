import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { evaluateRunStatus } from './runStatus.ts';

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
 * Starts a lightweight, unauthenticated read-only HTTP server exposing backup run telemetry
 * for LAN monitoring tools such as Home Assistant RESTful sensors or container healthchecks.
 *
 * Endpoints:
 * - `GET` / `HEAD` `/status` and `/status.json`: Always responds `200 OK` with evaluated JSON
 *   (`problem`, `healthy`, `overdue`, `ageHours`, timestamps, and aggregate counts) so pollers
 *   always parse attributes cleanly.
 * - `GET` / `HEAD` `/health`: Responds `200 OK` when `healthy === true` and `503 Service Unavailable`
 *   when `problem === true`.
 *
 * @param options - Server binding and status evaluation options.
 * @returns Promise resolving to the active {@link StatusServerHandle} once listening.
 */
export async function startStatusServer(options: StatusServerOptions): Promise<StatusServerHandle> {
  const nowProvider = options.nowProvider ?? (() => new Date());

  const server = http.createServer((request, response) => {
    const requestMethod = (request.method ?? 'GET').toUpperCase();
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

    let requestPathname = '/';
    try {
      const parsedRequestUrl = new URL(request.url ?? '/', 'http://localhost');
      requestPathname = parsedRequestUrl.pathname;
    } catch {
      sendJsonResponse(response, requestMethod, 400, { error: 'Invalid request URL' });
      return;
    }

    if (requestPathname === '/status' || requestPathname === '/status.json') {
      const evaluatedStatus = evaluateRunStatus(
        options.statusFilePath,
        options.maxAgeHours,
        nowProvider(),
      );
      sendJsonResponse(response, requestMethod, 200, evaluatedStatus);
      return;
    }

    if (requestPathname === '/health') {
      const evaluatedStatus = evaluateRunStatus(
        options.statusFilePath,
        options.maxAgeHours,
        nowProvider(),
      );
      const httpStatusCode = evaluatedStatus.healthy ? 200 : 503;
      sendJsonResponse(response, requestMethod, httpStatusCode, evaluatedStatus);
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

  options.log?.(
    `Status server listening on http://${boundHost}:${boundPort} (statusFile=${options.statusFilePath}, maxAgeHours=${options.maxAgeHours})`,
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
