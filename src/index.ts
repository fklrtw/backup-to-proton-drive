import { getUsageText, parseApplicationConfiguration } from './config.ts';
import { formatProtonAppVersionHeader } from './format.ts';
import {
  ensureAuthenticatedSession,
  releaseProtonCrypto,
  runInteractiveLogin,
} from './proton/auth.ts';
import { SdkProtonDriveAdapter } from './proton/client.ts';
import { markSyncRunStarted, recordSyncCompletion, recordSyncFailure } from './runStatus.ts';
import { startStatusServer } from './statusServer.ts';
import { executeSyncRun } from './syncRunner.ts';

/**
 * Injected at bundle time via `scripts/build.mjs` `define` option; falls back safely when
 * executed directly in development without bundling.
 */
declare const __APPLICATION_VERSION__: string | undefined;

const resolvedApplicationVersion =
  typeof __APPLICATION_VERSION__ !== 'undefined' ? __APPLICATION_VERSION__ : '0.1.0';

/**
 * Executes a non-fatal status file update while logging unexpected filesystem errors to `stderr`
 * so telemetry persistence problems never abort an otherwise healthy backup operation.
 *
 * @param updateOperation - Status persistence callback to run.
 * @param operationDescription - Short context label included in warning output on error.
 */
function tryUpdateStatusFile(updateOperation: () => void, operationDescription: string): void {
  try {
    updateOperation();
  } catch (statusError) {
    const statusErrorMessage =
      statusError instanceof Error ? statusError.message : String(statusError);
    console.error(`Warning: failed to ${operationDescription}: ${statusErrorMessage}`);
  }
}

/**
 * Prints non-sensitive startup diagnostics when `--verbose` / `VERBOSE=true` is enabled.
 * Passwords, tokens, TOTP secrets, and encryption key bytes are never logged.
 *
 * @param configuration - Parsed application configuration.
 */
function logVerboseStartupSummary(configuration: ReturnType<typeof parseApplicationConfiguration>): void {
  if (configuration.command === 'status-server') {
    console.log('[verbose] Runtime configuration:');
    console.table({
      Command: configuration.command,
      Version: configuration.applicationVersion,
      'Status File': configuration.statusFilePath,
      'Status Host': configuration.statusServerHost,
      'Status Port': configuration.statusServerPort,
      'Max Age Hours': configuration.statusMaxAgeHours,
    });
    return;
  }

  if (configuration.command === 'report-failure') {
    console.log('[verbose] Runtime configuration:');
    console.table({
      Command: configuration.command,
      Version: configuration.applicationVersion,
      'Status File': configuration.statusFilePath,
    });
    return;
  }

  const appVersionHeader = formatProtonAppVersionHeader(configuration.applicationVersion);
  const encryptionMode = configuration.dataEncryptionKey
    ? 'AES-256-GCM (HKDF-SHA256 key loaded from file)'
    : 'plaintext opt-out (--allow-plaintext-state)';

  const runtimeConfigurationTable = {
    Command: configuration.command,
    Version: configuration.applicationVersion,
    'App Version Header': appVersionHeader,
    'API Host': configuration.apiBaseHost,
    'Session File': configuration.sessionFilePath,
    'State File': configuration.stateFilePath,
    'Status File': configuration.statusFilePath,
    'Storage Protection': encryptionMode,
    'Dry Run': configuration.dryRun,
    'Upload Concurrency': configuration.uploadConcurrency,
    'Local Hash Concurrency': configuration.localHashConcurrency,
    'Remote Scan Concurrency': configuration.remoteScanConcurrency,
    'Small File Upload': configuration.enableSmallFileUpload,
  };

  console.log('[verbose] Runtime configuration:');
  console.table(runtimeConfigurationTable);

  if (configuration.mappings.length > 0) {
    const configuredMappingRows = configuration.mappings.map((mapping) => ({
      Local: mapping.localDirectory,
      Remote: mapping.remoteDirectory,
      'Trash Obsolete': mapping.trashObsolete,
      'Delete Empty Dirs': mapping.deleteEmptyRemoteDirectories,
      Excludes: mapping.excludePatterns.length,
    }));
    console.log('[verbose] Configured mappings:');
    console.table(configuredMappingRows);
  }
}

/**
 * Awaits an `AbortSignal` trigger so daemonized subcommands (`status-server`) can drain
 * cleanly on `SIGINT` or `SIGTERM`.
 *
 * @param abortSignal - Cancellation signal registered with process signal handlers.
 */
function waitForAbortSignal(abortSignal: AbortSignal): Promise<void> {
  if (abortSignal.aborted) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    abortSignal.addEventListener(
      'abort',
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Main CLI application entrypoint supporting `help`, interactive `login`, read-only HTTP
 * `status-server`, external `report-failure`, and one-shot multi-mapping Proton Drive sync.
 */
async function main(): Promise<void> {
  const configuration = parseApplicationConfiguration({
    applicationVersion: resolvedApplicationVersion,
  });

  if (configuration.command === 'help') {
    console.log(getUsageText());
    return;
  }

  if (configuration.verbose) {
    logVerboseStartupSummary(configuration);
  }

  if (configuration.command === 'report-failure') {
    const recordedStatus = recordSyncFailure(
      configuration.statusFilePath,
      configuration.failureMessage ?? 'External failure reported',
      null,
    );
    console.log(
      `Recorded failure status in ${configuration.statusFilePath}: ${recordedStatus.errorMessage}`,
    );
    return;
  }

  const abortController = new AbortController();
  let terminationExitCode: number | null = null;

  const registerSignalHandler = (signalName: 'SIGINT' | 'SIGTERM', exitCode: number) => {
    process.on(signalName, () => {
      if (terminationExitCode !== null) {
        process.exit(exitCode);
      }
      terminationExitCode = exitCode;
      const shutdownDescription =
        configuration.command === 'status-server'
          ? 'shutting down status server'
          : 'aborting active transfers';
      console.log(`\nReceived ${signalName}, ${shutdownDescription} cleanly...`);
      abortController.abort(new Error(`Terminated by ${signalName}`));
    });
  };

  registerSignalHandler('SIGINT', 130);
  registerSignalHandler('SIGTERM', 143);

  if (configuration.command === 'status-server') {
    const serverHandle = await startStatusServer({
      statusFilePath: configuration.statusFilePath,
      host: configuration.statusServerHost,
      port: configuration.statusServerPort,
      maxAgeHours: configuration.statusMaxAgeHours,
      log: (message) => {
        console.log(message);
      },
    });

    await waitForAbortSignal(abortController.signal);
    await serverHandle.close();

    if (terminationExitCode !== null) {
      process.exit(terminationExitCode);
    }
    return;
  }

  try {
    if (configuration.command === 'login') {
      await runInteractiveLogin(configuration);
      return;
    }

    const syncRunStartedTimeMs = Date.now();
    if (!configuration.dryRun) {
      tryUpdateStatusFile(() => {
        markSyncRunStarted(configuration.statusFilePath);
      }, 'mark sync run started');
    }

    try {
      const sessionManager = await ensureAuthenticatedSession(configuration);
      const adapter = new SdkProtonDriveAdapter({
        sessionManager,
        apiBaseHost: configuration.apiBaseHost,
        enableSmallFileUpload: configuration.enableSmallFileUpload,
        debugLogging: configuration.verbose,
      });

      const overallSummary = await executeSyncRun({
        adapter,
        configuration,
        abortSignal: abortController.signal,
      });

      if (!configuration.dryRun) {
        tryUpdateStatusFile(() => {
          recordSyncCompletion(configuration.statusFilePath, overallSummary);
        }, 'write completion status');
      }
    } catch (syncError) {
      if (!configuration.dryRun) {
        const elapsedDurationSeconds = (Date.now() - syncRunStartedTimeMs) / 1000;
        tryUpdateStatusFile(() => {
          recordSyncFailure(configuration.statusFilePath, syncError, elapsedDurationSeconds);
        }, 'write failure status');
      }
      throw syncError;
    }
  } finally {
    await releaseProtonCrypto();
  }

  if (terminationExitCode !== null) {
    process.exit(terminationExitCode);
  }
}

main().catch((error: unknown) => {
  if (error instanceof Error && error.message.startsWith('Terminated by SIGINT')) {
    process.exit(130);
  }
  if (error instanceof Error && error.message.startsWith('Terminated by SIGTERM')) {
    process.exit(143);
  }

  const errorMessage = error instanceof Error ? error.message : String(error);
  console.error(`Sync error: ${errorMessage}`);
  process.exit(1);
});
