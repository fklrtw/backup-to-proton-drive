import { getUsageText, parseApplicationConfiguration } from './config.ts';
import { formatProtonAppVersionHeader } from './format.ts';
import {
  ensureAuthenticatedSession,
  releaseProtonCrypto,
  runInteractiveLogin,
} from './proton/auth.ts';
import { SdkProtonDriveAdapter } from './proton/client.ts';
import { executeSyncRun } from './syncRunner.ts';

/**
 * Injected at bundle time via `scripts/build.mjs` `define` option; falls back safely when
 * executed directly in development without bundling.
 */
declare const __APPLICATION_VERSION__: string | undefined;

const resolvedApplicationVersion =
  typeof __APPLICATION_VERSION__ !== 'undefined' ? __APPLICATION_VERSION__ : '0.1.0';

/**
 * Prints non-sensitive startup diagnostics when `--verbose` / `VERBOSE=true` is enabled.
 * Passwords, tokens, TOTP secrets, and encryption key bytes are never logged.
 *
 * @param configuration - Parsed application configuration.
 */
function logVerboseStartupSummary(configuration: ReturnType<typeof parseApplicationConfiguration>): void {
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
 * Main CLI application entrypoint supporting `help`, interactive `login`, and one-shot
 * multi-mapping Proton Drive synchronization.
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

  const abortController = new AbortController();
  let terminationExitCode: number | null = null;

  const registerSignalHandler = (signalName: 'SIGINT' | 'SIGTERM', exitCode: number) => {
    process.on(signalName, () => {
      if (terminationExitCode !== null) {
        process.exit(exitCode);
      }
      terminationExitCode = exitCode;
      console.log(`\nReceived ${signalName}, aborting active transfers cleanly...`);
      abortController.abort(new Error(`Terminated by ${signalName}`));
    });
  };

  registerSignalHandler('SIGINT', 130);
  registerSignalHandler('SIGTERM', 143);

  try {
    if (configuration.command === 'login') {
      await runInteractiveLogin(configuration);
      return;
    }

    const sessionManager = await ensureAuthenticatedSession(configuration);
    const adapter = new SdkProtonDriveAdapter({
      sessionManager,
      apiBaseHost: configuration.apiBaseHost,
      enableSmallFileUpload: configuration.enableSmallFileUpload,
      debugLogging: configuration.verbose,
    });

    await executeSyncRun({
      adapter,
      configuration,
      abortSignal: abortController.signal,
    });
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
