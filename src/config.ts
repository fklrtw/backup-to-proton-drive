import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';

import { validateEncryptionKeyMaterial } from './storageEncryption.ts';
import type { ApplicationConfiguration, DirectoryMapping, HeadlessCredentials } from './types.ts';

/**
 * Options accepted by {@link parseApplicationConfiguration}.
 */
export interface ParseConfigurationOptions {
  /** CLI arguments excluding Node executable and script path (defaults to `process.argv.slice(2)`). */
  argv?: string[];
  /** Environment variable map (defaults to `process.env`). */
  environmentVariables?: NodeJS.ProcessEnv;
  /** Semantic application version embedded at build time. */
  applicationVersion?: string;
  /** Whether to verify that each configured local directory exists on disk during sync mode. */
  validateLocalDirectories?: boolean;
  /** Default data directory override used in tests when `/data` is not desired. */
  defaultDataDirectory?: string;
}

interface RawConfigurationFileMapping {
  localDir?: unknown;
  localDirectory?: unknown;
  remoteDir?: unknown;
  remoteDirectory?: unknown;
  exclude?: unknown;
  excludePatterns?: unknown;
  trashObsolete?: unknown;
  deleteEmptyRemoteDirectories?: unknown;
  deleteEmptyDirs?: unknown;
}

interface RawConfigurationFile {
  dryRun?: unknown;
  trashObsolete?: unknown;
  deleteEmptyRemoteDirectories?: unknown;
  deleteEmptyDirs?: unknown;
  uploadConcurrency?: unknown;
  localHashConcurrency?: unknown;
  remoteScanConcurrency?: unknown;
  enableSmallFileUpload?: unknown;
  verbose?: unknown;
  encryptionKeyFile?: unknown;
  allowPlaintextState?: unknown;
  exclude?: unknown;
  excludePatterns?: unknown;
  sessionFile?: unknown;
  sessionFilePath?: unknown;
  stateFile?: unknown;
  stateFilePath?: unknown;
  statusFile?: unknown;
  statusFilePath?: unknown;
  statusServerHost?: unknown;
  statusServerPort?: unknown;
  statusMaxAgeHours?: unknown;
  apiBaseHost?: unknown;
  mappings?: unknown;
}

/**
 * Generates formatted CLI usage and environment variable documentation.
 *
 * @returns Help text printed for `--help` / `-h`.
 */
export function getUsageText(): string {
  return [
    'Usage:',
    '  backup-to-proton-drive login [options]',
    '  backup-to-proton-drive status-server [options]',
    '  backup-to-proton-drive report-failure --message <reason> [options]',
    '  backup-to-proton-drive [options]',
    '  backup-to-proton-drive --map <LOCAL_DIR>:<REMOTE_DIR> [--map <LOCAL_DIR2>:<REMOTE_DIR2> ...]',
    '  backup-to-proton-drive <LOCAL_DIR> <REMOTE_DIR>',
    '',
    'Commands:',
    '  login                         Interactively authenticate with Proton and persist session file',
    '  status-server                 Run the read-only HTTP telemetry server exposing status.json',
    '  report-failure                Record an external pre-sync failure into status.json',
    '  (default)                     Run a one-shot SHA1-verified sync across all configured mappings',
    '',
    'Options:',
    '  -m, --map <local>:<remote>    Add a directory mapping (repeatable; L1->R1, L2->R2, ...)',
    '  -c, --config <path>           Path to YAML or JSON configuration file',
    '  -x, --exclude <glob>          Exclude glob pattern applied across mappings (repeatable)',
    '  -n, --dry-run                 Preview planned actions without modifying Proton Drive or cache',
    '      --delete-empty-dirs       Trash empty remote folders left behind after sync',
    '      --no-trash                Keep obsolete remote files instead of moving them to Trash',
    '      --concurrency <count>     Maximum concurrent file uploads (1-32, default: 5)',
    '      --small-file-upload       Enable single-request SDK uploads for files under 128 KiB',
    '      --encryption-key-file <path> Path to >=32-byte key file encrypting session.json and state.json',
    '      --allow-plaintext-state   Explicitly allow unencrypted 0600 JSON session/state files',
    '      --session-file <path>     Path to persisted session file',
    '      --state-file <path>       Path to persisted remote state and event cursor cache file',
    '      --status-file <path>      Path to unencrypted JSON run status file (default: status.json beside state)',
    '      --status-host <host>      Interface bound by status-server (default: 0.0.0.0)',
    '      --status-port <port>      TCP port bound by status-server (1-65535, default: 9108)',
    '      --status-max-age-hours <h> Max hours since lastSuccessAt before overdue (default: 26)',
    '      --message <text>          Failure description recorded by report-failure',
    '  -v, --verbose                 Enable verbose credential-safe diagnostic logging',
    '  -l, --local-dir <path>        Legacy single-mapping local source directory',
    '  -r, --remote-dir <path>       Legacy single-mapping remote Proton Drive directory',
    '  -h, --help                    Show this help text and exit',
    '',
    'Environment Variables:',
    '  SYNC_MAPPINGS                 Comma/semicolon/newline separated "L1:R1,L2:R2" or JSON array',
    '  CONFIG_FILE                   Path to YAML or JSON configuration file',
    '  LOCAL_DIR / REMOTE_DIR        Legacy single-mapping fallback',
    '  EXCLUDE_PATTERNS              Comma or newline separated global exclude globs',
    '  DRY_RUN                       Set true/1 to enable dry-run mode',
    '  VERBOSE                       Set true/1 to enable verbose diagnostic logging',
    '  TRASH_OBSOLETE                Set false/0 to disable trashing obsolete remote files',
    '  DELETE_EMPTY_DIRS             Set true/1 to trash obsolete empty remote folders',
    '  UPLOAD_CONCURRENCY            Max concurrent file uploads (1-32, default: 5)',
    '  LOCAL_HASH_CONCURRENCY        Max concurrent local SHA1 streams (1-64, default: 8)',
    '  REMOTE_SCAN_CONCURRENCY       Max concurrent remote folder scans (1-15, default: 6)',
    '  ENABLE_SMALL_FILE_UPLOAD      Set true/1 to enable single-request <128 KiB uploads',
    '  DATA_ENCRYPTION_KEY_FILE      Secret file (>=32 bytes) encrypting session.json and state.json at rest',
    '  ALLOW_PLAINTEXT_STATE         Set true/1 to allow plaintext 0600 storage without an encryption key',
    '  SESSION_FILE / STATE_FILE     Paths for persisted session and incremental event cache',
    '  STATUS_FILE                   Path to unencrypted JSON status file (default: status.json beside state)',
    '  STATUS_SERVER_HOST            Interface bound by status-server (default: 0.0.0.0)',
    '  STATUS_SERVER_PORT            TCP port bound by status-server (default: 9108)',
    '  STATUS_MAX_AGE_HOURS          Max hours since lastSuccessAt before overdue (default: 26)',
    '  FAILURE_MESSAGE               Fallback error message for report-failure',
    '  PROTON_USERNAME               Proton username/email for headless login (supports *_FILE)',
    '  PROTON_PASSWORD               Proton password for headless login (supports *_FILE)',
    '  PROTON_TOTP_SECRET            Optional Base32 TOTP secret for 2FA (supports *_FILE)',
    '  PROTON_MAILBOX_PASSWORD       Optional mailbox password for 2-password accounts (supports *_FILE)',
    '  PROTON_API_HOST               Optional API host override (default: drive-api.proton.me)',
  ].join('\n');
}

/**
 * Parses common boolean string representations (`true/1/yes` vs `false/0/no`).
 *
 * @param rawValue - Raw string environment variable or CLI flag value.
 * @returns Parsed boolean, or `undefined` when input is `undefined`.
 */
function parseBooleanEnvironmentValue(rawValue: string | undefined): boolean | undefined {
  if (rawValue === undefined) {
    return undefined;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (normalized === '') {
    return undefined;
  }
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }

  throw new Error(`Invalid boolean value "${rawValue}". Expected true/false or 1/0.`);
}

/**
 * Validates and parses a positive integer concurrency option within inclusive bounds.
 *
 * @param rawValue - Raw string or number value from CLI, environment, or YAML/JSON config.
 * @param optionName - Option name displayed in validation error messages.
 * @param minimumValue - Minimum permitted integer value.
 * @param maximumValue - Maximum permitted integer value.
 * @returns Validated integer, or `undefined` when `rawValue` is `undefined`.
 */
function parsePositiveIntegerOption(
  rawValue: unknown,
  optionName: string,
  minimumValue: number,
  maximumValue: number,
): number | undefined {
  if (rawValue === undefined || rawValue === null) {
    return undefined;
  }

  let parsedNumber: number;
  if (typeof rawValue === 'number') {
    parsedNumber = rawValue;
  } else if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    if (!/^-?\d+$/.test(trimmed)) {
      throw new Error(`Invalid integer value "${rawValue}" for ${optionName}.`);
    }
    parsedNumber = Number.parseInt(trimmed, 10);
  } else {
    throw new Error(`Configuration option ${optionName} must be an integer.`);
  }

  if (!Number.isInteger(parsedNumber) || parsedNumber < minimumValue || parsedNumber > maximumValue) {
    throw new Error(
      `Option ${optionName} must be an integer between ${minimumValue} and ${maximumValue} (received ${parsedNumber}).`,
    );
  }

  return parsedNumber;
}

/**
 * Validates and parses a positive numeric option (integer or decimal) within bounds.
 *
 * @param rawValue - Raw string or number value from CLI, environment, or YAML/JSON config.
 * @param optionName - Option name displayed in validation error messages.
 * @param exclusiveMinimumValue - Strict lower bound (`value > exclusiveMinimumValue`).
 * @param maximumValue - Inclusive upper bound (`value <= maximumValue`).
 * @returns Validated finite number, or `undefined` when `rawValue` is `undefined`.
 */
function parsePositiveNumberOption(
  rawValue: unknown,
  optionName: string,
  exclusiveMinimumValue: number,
  maximumValue: number,
): number | undefined {
  if (rawValue === undefined || rawValue === null) {
    return undefined;
  }

  let parsedNumber: number;
  if (typeof rawValue === 'number') {
    parsedNumber = rawValue;
  } else if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      throw new Error(`Invalid number value "${rawValue}" for ${optionName}.`);
    }
    parsedNumber = Number.parseFloat(trimmed);
  } else {
    throw new Error(`Configuration option ${optionName} must be a number.`);
  }

  if (
    !Number.isFinite(parsedNumber) ||
    parsedNumber <= exclusiveMinimumValue ||
    parsedNumber > maximumValue
  ) {
    throw new Error(
      `Option ${optionName} must be greater than ${exclusiveMinimumValue} and at most ${maximumValue} (received ${parsedNumber}).`,
    );
  }

  return parsedNumber;
}

/**
 * Reads a credential either from a Docker/Podman secret file (`${name}_FILE`) or directly
 * from `environmentVariables[name]`.
 *
 * @param environmentVariables - Process environment map.
 * @param variableName - Base environment variable name (e.g., `PROTON_PASSWORD`).
 * @returns Secret string with a single trailing newline stripped, or `undefined`.
 */
export function readSecretOrEnvironmentVariable(
  environmentVariables: NodeJS.ProcessEnv,
  variableName: string,
): string | undefined {
  const fileVariableName = `${variableName}_FILE`;
  const secretFilePath = environmentVariables[fileVariableName];

  if (secretFilePath !== undefined && secretFilePath.trim().length > 0) {
    const resolvedSecretPath = path.resolve(secretFilePath.trim());
    if (!fs.existsSync(resolvedSecretPath)) {
      throw new Error(`Secret file referenced by ${fileVariableName} does not exist: ${resolvedSecretPath}`);
    }
    return fs.readFileSync(resolvedSecretPath, 'utf8').replace(/\r?\n$/, '');
  }

  const directValue = environmentVariables[variableName];
  if (directValue !== undefined && directValue.length > 0) {
    return directValue;
  }

  return undefined;
}

/**
 * Normalizes a remote Proton Drive folder path to canonical POSIX format.
 * Preserves `'/'` when explicitly targeting the My Files root and strips trailing slashes
 * from all nested paths.
 *
 * @param rawRemoteDirectory - Unnormalized remote directory string.
 * @returns Normalized remote POSIX path starting with `'/'`.
 */
export function normalizeRemoteDirectory(rawRemoteDirectory: string): string {
  const trimmed = rawRemoteDirectory.trim();
  if (!trimmed.startsWith('/')) {
    throw new Error(`REMOTE_DIR must be an absolute remote path starting with '/': ${rawRemoteDirectory}`);
  }

  const normalized = path.posix.normalize(trimmed);
  if (normalized === '/') {
    return '/';
  }

  const withoutTrailingSlashes = normalized.replace(/\/+$/, '');
  if (!withoutTrailingSlashes.startsWith('/')) {
    throw new Error(`REMOTE_DIR must remain inside Proton Drive root '/': ${rawRemoteDirectory}`);
  }

  return withoutTrailingSlashes;
}

/**
 * Splits a `<localDirectory>:<remoteDirectory>` mapping specification safely.
 * Prefers splitting on the last `:/` boundary so local paths containing colons
 * (such as Windows drive letters or colon filenames) parse unambiguously.
 *
 * @param rawMapping - Mapping specification string.
 * @returns Tuple containing raw local and remote path components.
 */
export function splitMappingSpecification(rawMapping: string): {
  localDirectory: string;
  remoteDirectory: string;
} {
  const trimmed = rawMapping.trim();
  const slashBoundaryIndex = trimmed.lastIndexOf(':/');

  if (slashBoundaryIndex > 0) {
    const localDirectory = trimmed.slice(0, slashBoundaryIndex).trim();
    const remoteDirectory = trimmed.slice(slashBoundaryIndex + 1).trim();
    if (localDirectory.length > 0 && remoteDirectory.length > 0) {
      return { localDirectory, remoteDirectory };
    }
  }

  const lastColonIndex = trimmed.lastIndexOf(':');
  if (lastColonIndex > 0) {
    const localDirectory = trimmed.slice(0, lastColonIndex).trim();
    const remoteDirectory = trimmed.slice(lastColonIndex + 1).trim();
    if (localDirectory.length > 0 && remoteDirectory.length > 0) {
      return { localDirectory, remoteDirectory };
    }
  }

  throw new Error(
    `Invalid mapping specification "${rawMapping}". Expected "<localDirectory>:<remoteDirectory>" (for example "/data/export:/Backups/Export").`,
  );
}

/**
 * Coerces an unknown array value from YAML/JSON config into a list of string patterns.
 *
 * @param rawPatterns - Raw YAML/JSON value.
 * @param fieldName - Field label used in validation errors.
 * @returns Validated string array.
 */
function parseStringArrayField(rawPatterns: unknown, fieldName: string): string[] {
  if (rawPatterns === undefined || rawPatterns === null) {
    return [];
  }
  if (!Array.isArray(rawPatterns)) {
    throw new Error(`Configuration field "${fieldName}" must be an array of strings.`);
  }
  return rawPatterns.map((entry, entryIndex) => {
    if (typeof entry !== 'string') {
      throw new Error(`Configuration field "${fieldName}[${entryIndex}]" must be a string.`);
    }
    return entry;
  });
}

/**
 * Parses mapping objects loaded from JSON/YAML config or JSON-formatted `SYNC_MAPPINGS`.
 *
 * @param rawMapping - Raw object or `"local:remote"` string.
 * @param defaults - Global fallback options.
 * @param sourceLabel - Source description used in error messages.
 * @returns Normalized {@link DirectoryMapping}.
 */
function parseMappingObject(
  rawMapping: unknown,
  defaults: {
    globalExcludes: string[];
    trashObsolete: boolean;
    deleteEmptyRemoteDirectories: boolean;
  },
  sourceLabel: string,
): DirectoryMapping {
  if (typeof rawMapping === 'string') {
    const splitPair = splitMappingSpecification(rawMapping);
    return {
      localDirectory: path.resolve(splitPair.localDirectory),
      remoteDirectory: normalizeRemoteDirectory(splitPair.remoteDirectory),
      excludePatterns: [...defaults.globalExcludes],
      trashObsolete: defaults.trashObsolete,
      deleteEmptyRemoteDirectories: defaults.deleteEmptyRemoteDirectories,
    };
  }

  if (typeof rawMapping !== 'object' || rawMapping === null || Array.isArray(rawMapping)) {
    throw new Error(`Invalid mapping entry in ${sourceLabel}: expected an object or "local:remote" string.`);
  }

  const typedMapping = rawMapping as RawConfigurationFileMapping;
  const rawLocal = typedMapping.localDirectory ?? typedMapping.localDir;
  const rawRemote = typedMapping.remoteDirectory ?? typedMapping.remoteDir;

  if (typeof rawLocal !== 'string' || rawLocal.trim().length === 0) {
    throw new Error(`Mapping in ${sourceLabel} is missing a non-empty "localDirectory" (or "localDir") string.`);
  }
  if (typeof rawRemote !== 'string' || rawRemote.trim().length === 0) {
    throw new Error(`Mapping in ${sourceLabel} is missing a non-empty "remoteDirectory" (or "remoteDir") string.`);
  }

  const mappingExcludes = [
    ...defaults.globalExcludes,
    ...parseStringArrayField(typedMapping.exclude ?? typedMapping.excludePatterns, `${sourceLabel}.exclude`),
  ];

  const trashObsoleteValue = typedMapping.trashObsolete;
  if (trashObsoleteValue !== undefined && typeof trashObsoleteValue !== 'boolean') {
    throw new Error(`Mapping field "trashObsolete" in ${sourceLabel} must be a boolean.`);
  }

  const deleteEmptyValue = typedMapping.deleteEmptyRemoteDirectories ?? typedMapping.deleteEmptyDirs;
  if (deleteEmptyValue !== undefined && typeof deleteEmptyValue !== 'boolean') {
    throw new Error(`Mapping field "deleteEmptyRemoteDirectories" in ${sourceLabel} must be a boolean.`);
  }

  return {
    localDirectory: path.resolve(rawLocal.trim()),
    remoteDirectory: normalizeRemoteDirectory(rawRemote),
    excludePatterns: mappingExcludes,
    trashObsolete: trashObsoleteValue ?? defaults.trashObsolete,
    deleteEmptyRemoteDirectories: deleteEmptyValue ?? defaults.deleteEmptyRemoteDirectories,
  };
}

/**
 * Ensures no two mappings point to identical or nested remote directories, because
 * an ancestor mapping with `trashObsolete` enabled would treat a nested mapping's
 * remote files as obsolete and move them to Trash.
 *
 * @param mappings - Configured directory mappings.
 */
function assertNoOverlappingRemoteDirectories(mappings: readonly DirectoryMapping[]): void {
  for (let outerIndex = 0; outerIndex < mappings.length; outerIndex++) {
    const firstMapping = mappings[outerIndex];
    if (!firstMapping) {
      continue;
    }

    for (let innerIndex = outerIndex + 1; innerIndex < mappings.length; innerIndex++) {
      const secondMapping = mappings[innerIndex];
      if (!secondMapping) {
        continue;
      }

      if (firstMapping.remoteDirectory === secondMapping.remoteDirectory) {
        throw new Error(
          `Duplicate remoteDirectory "${firstMapping.remoteDirectory}" across mappings. Each mapping must target a distinct remote folder.`,
        );
      }

      const firstPrefix = firstMapping.remoteDirectory === '/' ? '/' : `${firstMapping.remoteDirectory}/`;
      const secondPrefix = secondMapping.remoteDirectory === '/' ? '/' : `${secondMapping.remoteDirectory}/`;

      if (
        secondMapping.remoteDirectory.startsWith(firstPrefix) ||
        firstMapping.remoteDirectory.startsWith(secondPrefix)
      ) {
        throw new Error(
          `Overlapping remoteDirectory paths "${firstMapping.remoteDirectory}" and "${secondMapping.remoteDirectory}" are not allowed because a parent mapping could trash files managed by the nested mapping.`,
        );
      }
    }
  }
}

/**
 * Parses and validates CLI arguments, optional YAML/JSON config files, environment variables,
 * and Docker/Podman secret files into an {@link ApplicationConfiguration}.
 *
 * @param options - Optional overrides primarily used by unit tests.
 * @returns Validated application configuration.
 */
export function parseApplicationConfiguration(
  options: ParseConfigurationOptions = {},
): ApplicationConfiguration {
  const argv = options.argv ?? process.argv.slice(2);
  const environmentVariables = options.environmentVariables ?? process.env;
  const applicationVersion = options.applicationVersion ?? '0.1.0';
  const validateLocalDirectories = options.validateLocalDirectories ?? true;

  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c' },
      map: { type: 'string', short: 'm', multiple: true },
      exclude: { type: 'string', short: 'x', multiple: true },
      'dry-run': { type: 'boolean', short: 'n' },
      'delete-empty-dirs': { type: 'boolean' },
      'no-trash': { type: 'boolean' },
      concurrency: { type: 'string' },
      'small-file-upload': { type: 'boolean' },
      verbose: { type: 'boolean', short: 'v' },
      'encryption-key-file': { type: 'string' },
      'allow-plaintext-state': { type: 'boolean' },
      'session-file': { type: 'string' },
      'state-file': { type: 'string' },
      'status-file': { type: 'string' },
      'status-host': { type: 'string' },
      'status-port': { type: 'string' },
      'status-max-age-hours': { type: 'string' },
      message: { type: 'string' },
      'local-dir': { type: 'string', short: 'l' },
      'remote-dir': { type: 'string', short: 'r' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    return {
      command: 'help',
      mappings: [],
      dryRun: false,
      sessionFilePath: '',
      stateFilePath: '',
      statusFilePath: '',
      statusServerHost: '0.0.0.0',
      statusServerPort: 9108,
      statusMaxAgeHours: 26,
      apiBaseHost: 'drive-api.proton.me',
      applicationVersion,
      uploadConcurrency: 5,
      localHashConcurrency: 8,
      remoteScanConcurrency: 6,
      enableSmallFileUpload: false,
      verbose: false,
      dataEncryptionKey: undefined,
      allowPlaintextState: false,
      headlessCredentials: {},
    };
  }

  const rawSubcommand = positionals[0];
  let command: ApplicationConfiguration['command'] = 'sync';
  if (rawSubcommand === 'login') {
    command = 'login';
  } else if (rawSubcommand === 'status-server') {
    command = 'status-server';
  } else if (rawSubcommand === 'report-failure') {
    command = 'report-failure';
  }

  const configFilePath = values.config ?? environmentVariables.CONFIG_FILE;
  let parsedConfigFile: RawConfigurationFile = {};

  if (configFilePath !== undefined && configFilePath.trim().length > 0) {
    const resolvedConfigPath = path.resolve(configFilePath.trim());
    if (!fs.existsSync(resolvedConfigPath)) {
      throw new Error(`Configuration file does not exist: ${resolvedConfigPath}`);
    }
    const rawConfigContent = fs.readFileSync(resolvedConfigPath, 'utf8');
    const loadedConfig: unknown = parseYaml(rawConfigContent);
    if (loadedConfig !== null && loadedConfig !== undefined) {
      if (typeof loadedConfig !== 'object' || Array.isArray(loadedConfig)) {
        throw new Error(`Configuration file must define a top-level object: ${resolvedConfigPath}`);
      }
      parsedConfigFile = loadedConfig as RawConfigurationFile;
    }
  }

  const defaultDataDirectory =
    options.defaultDataDirectory ?? (fs.existsSync('/data') ? '/data' : path.resolve('data'));

  const configSessionFile =
    typeof parsedConfigFile.sessionFile === 'string'
      ? parsedConfigFile.sessionFile
      : typeof parsedConfigFile.sessionFilePath === 'string'
        ? parsedConfigFile.sessionFilePath
        : undefined;
  const sessionFilePath = path.resolve(
    values['session-file'] ??
      environmentVariables.SESSION_FILE ??
      configSessionFile ??
      path.join(defaultDataDirectory, 'session.json'),
  );

  const configStateFile =
    typeof parsedConfigFile.stateFile === 'string'
      ? parsedConfigFile.stateFile
      : typeof parsedConfigFile.stateFilePath === 'string'
        ? parsedConfigFile.stateFilePath
        : undefined;
  const stateFilePath = path.resolve(
    values['state-file'] ??
      environmentVariables.STATE_FILE ??
      configStateFile ??
      path.join(defaultDataDirectory, 'state.json'),
  );

  if (
    parsedConfigFile.statusFile !== undefined &&
    typeof parsedConfigFile.statusFile !== 'string'
  ) {
    throw new Error('Configuration field "statusFile" must be a string path.');
  }
  const configStatusFile =
    typeof parsedConfigFile.statusFile === 'string'
      ? parsedConfigFile.statusFile
      : typeof parsedConfigFile.statusFilePath === 'string'
        ? parsedConfigFile.statusFilePath
        : undefined;
  const statusFilePath = path.resolve(
    values['status-file'] ??
      environmentVariables.STATUS_FILE ??
      configStatusFile ??
      path.join(path.dirname(stateFilePath), 'status.json'),
  );

  if (
    parsedConfigFile.statusServerHost !== undefined &&
    typeof parsedConfigFile.statusServerHost !== 'string'
  ) {
    throw new Error('Configuration field "statusServerHost" must be a string.');
  }
  const rawStatusServerHost =
    values['status-host'] ??
    environmentVariables.STATUS_SERVER_HOST ??
    (typeof parsedConfigFile.statusServerHost === 'string'
      ? parsedConfigFile.statusServerHost
      : undefined) ??
    '0.0.0.0';
  const statusServerHost = rawStatusServerHost.trim();
  if (statusServerHost.length === 0) {
    throw new Error('Status server host cannot be empty.');
  }

  const statusServerPort =
    parsePositiveIntegerOption(values['status-port'], '--status-port', 1, 65535) ??
    parsePositiveIntegerOption(
      environmentVariables.STATUS_SERVER_PORT,
      'STATUS_SERVER_PORT',
      1,
      65535,
    ) ??
    parsePositiveIntegerOption(
      parsedConfigFile.statusServerPort,
      'config.statusServerPort',
      1,
      65535,
    ) ??
    9108;

  const statusMaxAgeHours =
    parsePositiveNumberOption(values['status-max-age-hours'], '--status-max-age-hours', 0, 8760) ??
    parsePositiveNumberOption(
      environmentVariables.STATUS_MAX_AGE_HOURS,
      'STATUS_MAX_AGE_HOURS',
      0,
      8760,
    ) ??
    parsePositiveNumberOption(
      parsedConfigFile.statusMaxAgeHours,
      'config.statusMaxAgeHours',
      0,
      8760,
    ) ??
    26;

  let failureMessage: string | undefined;
  if (command === 'report-failure') {
    const positionalFailureMessage = positionals.slice(1).join(' ').trim();
    const resolvedFailureMessage = (
      values.message ??
      (positionalFailureMessage.length > 0 ? positionalFailureMessage : undefined) ??
      environmentVariables.FAILURE_MESSAGE ??
      ''
    ).trim();
    if (resolvedFailureMessage.length === 0) {
      throw new Error(
        'Missing failure message for report-failure. Pass --message "<reason>", positional text, or set FAILURE_MESSAGE.',
      );
    }
    failureMessage = resolvedFailureMessage;
  }

  const apiBaseHostRaw =
    environmentVariables.PROTON_API_HOST ??
    (typeof parsedConfigFile.apiBaseHost === 'string' ? parsedConfigFile.apiBaseHost : undefined) ??
    'drive-api.proton.me';
  const apiBaseHost = apiBaseHostRaw.replace(/^https?:\/\//, '').replace(/\/+$/, '');

  const configDryRun = typeof parsedConfigFile.dryRun === 'boolean' ? parsedConfigFile.dryRun : undefined;
  const dryRun =
    values['dry-run'] ?? parseBooleanEnvironmentValue(environmentVariables.DRY_RUN) ?? configDryRun ?? false;

  const configTrashObsolete =
    typeof parsedConfigFile.trashObsolete === 'boolean' ? parsedConfigFile.trashObsolete : undefined;
  const trashObsolete =
    values['no-trash'] === true
      ? false
      : (parseBooleanEnvironmentValue(environmentVariables.TRASH_OBSOLETE) ?? configTrashObsolete ?? true);

  const configDeleteEmpty =
    typeof parsedConfigFile.deleteEmptyRemoteDirectories === 'boolean'
      ? parsedConfigFile.deleteEmptyRemoteDirectories
      : typeof parsedConfigFile.deleteEmptyDirs === 'boolean'
        ? parsedConfigFile.deleteEmptyDirs
        : undefined;
  const deleteEmptyRemoteDirectories =
    values['delete-empty-dirs'] ??
    parseBooleanEnvironmentValue(environmentVariables.DELETE_EMPTY_DIRS) ??
    configDeleteEmpty ??
    false;

  const envExcludePatterns = (environmentVariables.EXCLUDE_PATTERNS ?? '')
    .split(/[\n,]+/)
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0);
  const configExcludePatterns = parseStringArrayField(
    parsedConfigFile.exclude ?? parsedConfigFile.excludePatterns,
    'exclude',
  );
  const cliExcludePatterns = values.exclude ?? [];
  const globalExcludes = [...configExcludePatterns, ...envExcludePatterns, ...cliExcludePatterns];

  const mappingDefaults = {
    globalExcludes,
    trashObsolete,
    deleteEmptyRemoteDirectories,
  };

  let mappings: DirectoryMapping[] = [];

  if (command === 'sync') {
    const cliMapFlags = values.map ?? [];
    const hasLegacyCliLocal = values['local-dir'] !== undefined;
    const hasLegacyCliRemote = values['remote-dir'] !== undefined;
    const legacyPositionalLocal = !hasLegacyCliLocal ? positionals[0] : undefined;
    const legacyPositionalRemote = hasLegacyCliLocal ? positionals[0] : positionals[1];

    if (cliMapFlags.length > 0) {
      mappings = cliMapFlags.map((rawMapping) => parseMappingObject(rawMapping, mappingDefaults, '--map'));
    } else if (
      hasLegacyCliLocal ||
      hasLegacyCliRemote ||
      legacyPositionalLocal !== undefined ||
      legacyPositionalRemote !== undefined
    ) {
      const resolvedRawLocal = values['local-dir'] ?? legacyPositionalLocal ?? environmentVariables.LOCAL_DIR;
      const resolvedRawRemote = values['remote-dir'] ?? legacyPositionalRemote ?? environmentVariables.REMOTE_DIR;

      if (!resolvedRawLocal || !resolvedRawRemote) {
        throw new Error(
          'Missing required directory mapping. Provide --map LOCAL:REMOTE, --local-dir and --remote-dir, or positional [LOCAL_DIR] [REMOTE_DIR].',
        );
      }

      mappings = [
        {
          localDirectory: path.resolve(resolvedRawLocal),
          remoteDirectory: normalizeRemoteDirectory(resolvedRawRemote),
          excludePatterns: [...globalExcludes],
          trashObsolete,
          deleteEmptyRemoteDirectories,
        },
      ];
    } else if (parsedConfigFile.mappings !== undefined) {
      if (!Array.isArray(parsedConfigFile.mappings)) {
        throw new Error('Configuration field "mappings" must be an array.');
      }
      mappings = parsedConfigFile.mappings.map((entry, entryIndex) =>
        parseMappingObject(entry, mappingDefaults, `config.mappings[${entryIndex}]`),
      );
    } else if (environmentVariables.SYNC_MAPPINGS && environmentVariables.SYNC_MAPPINGS.trim().length > 0) {
      const rawSyncMappings = environmentVariables.SYNC_MAPPINGS.trim();
      if (rawSyncMappings.startsWith('[')) {
        const parsedMappings: unknown = JSON.parse(rawSyncMappings);
        if (!Array.isArray(parsedMappings)) {
          throw new Error('SYNC_MAPPINGS JSON value must be an array.');
        }
        mappings = parsedMappings.map((entry, entryIndex) =>
          parseMappingObject(entry, mappingDefaults, `SYNC_MAPPINGS[${entryIndex}]`),
        );
      } else {
        const splitEntries = rawSyncMappings
          .split(/[\n;,]+/)
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
        mappings = splitEntries.map((entry) => parseMappingObject(entry, mappingDefaults, 'SYNC_MAPPINGS'));
      }
    } else if (environmentVariables.LOCAL_DIR && environmentVariables.REMOTE_DIR) {
      mappings = [
        {
          localDirectory: path.resolve(environmentVariables.LOCAL_DIR),
          remoteDirectory: normalizeRemoteDirectory(environmentVariables.REMOTE_DIR),
          excludePatterns: [...globalExcludes],
          trashObsolete,
          deleteEmptyRemoteDirectories,
        },
      ];
    }

    if (mappings.length === 0) {
      throw new Error(
        'No directory mappings configured. Set SYNC_MAPPINGS="L1:R1,L2:R2", provide --config, pass --map LOCAL:REMOTE, or set LOCAL_DIR and REMOTE_DIR.',
      );
    }

    if (validateLocalDirectories) {
      for (const mapping of mappings) {
        if (!fs.existsSync(mapping.localDirectory) || !fs.statSync(mapping.localDirectory).isDirectory()) {
          throw new Error(`Local directory does not exist or is not a directory: ${mapping.localDirectory}`);
        }
      }
    }

    assertNoOverlappingRemoteDirectories(mappings);
  }

  const uploadConcurrency =
    parsePositiveIntegerOption(values.concurrency, '--concurrency', 1, 32) ??
    parsePositiveIntegerOption(environmentVariables.UPLOAD_CONCURRENCY, 'UPLOAD_CONCURRENCY', 1, 32) ??
    parsePositiveIntegerOption(parsedConfigFile.uploadConcurrency, 'config.uploadConcurrency', 1, 32) ??
    5;

  const localHashConcurrency =
    parsePositiveIntegerOption(
      environmentVariables.LOCAL_HASH_CONCURRENCY,
      'LOCAL_HASH_CONCURRENCY',
      1,
      64,
    ) ??
    parsePositiveIntegerOption(
      parsedConfigFile.localHashConcurrency,
      'config.localHashConcurrency',
      1,
      64,
    ) ??
    8;

  const remoteScanConcurrency =
    parsePositiveIntegerOption(
      environmentVariables.REMOTE_SCAN_CONCURRENCY,
      'REMOTE_SCAN_CONCURRENCY',
      1,
      15,
    ) ??
    parsePositiveIntegerOption(
      parsedConfigFile.remoteScanConcurrency,
      'config.remoteScanConcurrency',
      1,
      15,
    ) ??
    6;

  const configEnableSmallFileUpload =
    typeof parsedConfigFile.enableSmallFileUpload === 'boolean'
      ? parsedConfigFile.enableSmallFileUpload
      : undefined;
  const enableSmallFileUpload =
    values['small-file-upload'] ??
    parseBooleanEnvironmentValue(environmentVariables.ENABLE_SMALL_FILE_UPLOAD) ??
    configEnableSmallFileUpload ??
    false;

  if (parsedConfigFile.verbose !== undefined && typeof parsedConfigFile.verbose !== 'boolean') {
    throw new Error('Configuration field "verbose" must be a boolean.');
  }
  const configVerbose = typeof parsedConfigFile.verbose === 'boolean' ? parsedConfigFile.verbose : undefined;
  const verbose =
    values.verbose ?? parseBooleanEnvironmentValue(environmentVariables.VERBOSE) ?? configVerbose ?? false;

  if (
    environmentVariables.DATA_ENCRYPTION_KEY !== undefined &&
    environmentVariables.DATA_ENCRYPTION_KEY.trim().length > 0
  ) {
    throw new Error(
      'DATA_ENCRYPTION_KEY environment variable is not supported for security reasons (environment variables are visible in container inspect). Mount a secret file and set DATA_ENCRYPTION_KEY_FILE or pass --encryption-key-file instead.',
    );
  }

  if (
    parsedConfigFile.encryptionKeyFile !== undefined &&
    typeof parsedConfigFile.encryptionKeyFile !== 'string'
  ) {
    throw new Error('Configuration field "encryptionKeyFile" must be a string path.');
  }
  const configEncryptionKeyFile =
    typeof parsedConfigFile.encryptionKeyFile === 'string'
      ? parsedConfigFile.encryptionKeyFile
      : undefined;

  if (
    parsedConfigFile.allowPlaintextState !== undefined &&
    typeof parsedConfigFile.allowPlaintextState !== 'boolean'
  ) {
    throw new Error('Configuration field "allowPlaintextState" must be a boolean.');
  }
  const configAllowPlaintextState =
    typeof parsedConfigFile.allowPlaintextState === 'boolean'
      ? parsedConfigFile.allowPlaintextState
      : undefined;

  const allowPlaintextState =
    values['allow-plaintext-state'] ??
    parseBooleanEnvironmentValue(environmentVariables.ALLOW_PLAINTEXT_STATE) ??
    configAllowPlaintextState ??
    false;

  const requiresEncryptedSessionOrState = command === 'login' || command === 'sync';

  const encryptionKeyFilePath =
    values['encryption-key-file'] ??
    environmentVariables.DATA_ENCRYPTION_KEY_FILE ??
    configEncryptionKeyFile;

  let dataEncryptionKey: Buffer | undefined;
  if (
    requiresEncryptedSessionOrState &&
    encryptionKeyFilePath !== undefined &&
    encryptionKeyFilePath.trim().length > 0
  ) {
    const resolvedEncryptionKeyPath = path.resolve(encryptionKeyFilePath.trim());
    if (!fs.existsSync(resolvedEncryptionKeyPath)) {
      throw new Error(`Encryption key file does not exist: ${resolvedEncryptionKeyPath}`);
    }
    const rawEncryptionKeyText = fs.readFileSync(resolvedEncryptionKeyPath, 'utf8');
    dataEncryptionKey = validateEncryptionKeyMaterial(
      rawEncryptionKeyText,
      resolvedEncryptionKeyPath,
    );
  }

  if (requiresEncryptedSessionOrState && !dataEncryptionKey && !allowPlaintextState) {
    throw new Error(
      'At-rest encryption key is required for session.json and state.json. Mount a key file (>= 32 bytes, e.g. generated with "openssl rand -base64 32") and set DATA_ENCRYPTION_KEY_FILE (or --encryption-key-file), or explicitly opt out with ALLOW_PLAINTEXT_STATE=true (--allow-plaintext-state).',
    );
  }

  const headlessCredentials: HeadlessCredentials = {
    username: readSecretOrEnvironmentVariable(environmentVariables, 'PROTON_USERNAME'),
    password: readSecretOrEnvironmentVariable(environmentVariables, 'PROTON_PASSWORD'),
    totpSecret: readSecretOrEnvironmentVariable(environmentVariables, 'PROTON_TOTP_SECRET'),
    mailboxPassword: readSecretOrEnvironmentVariable(environmentVariables, 'PROTON_MAILBOX_PASSWORD'),
  };

  return {
    command,
    mappings,
    dryRun,
    sessionFilePath,
    stateFilePath,
    statusFilePath,
    statusServerHost,
    statusServerPort,
    statusMaxAgeHours,
    failureMessage,
    apiBaseHost,
    applicationVersion,
    uploadConcurrency,
    localHashConcurrency,
    remoteScanConcurrency,
    enableSmallFileUpload,
    verbose,
    dataEncryptionKey,
    allowPlaintextState,
    headlessCredentials,
  };
}
