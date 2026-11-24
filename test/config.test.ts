import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  normalizeRemoteDirectory,
  parseApplicationConfiguration,
  readSecretOrEnvironmentVariable,
  splitMappingSpecification,
} from '../src/config.ts';

describe('configuration parsing', () => {
  let temporaryRoot = '';
  let localDirectoryOne = '';
  let localDirectoryTwo = '';
  let dataDirectory = '';
  let encryptionKeyFilePath = '';

  before(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'proton-backup-config-test-'));
    localDirectoryOne = path.join(temporaryRoot, 'local-one');
    localDirectoryTwo = path.join(temporaryRoot, 'local-two');
    dataDirectory = path.join(temporaryRoot, 'data');
    encryptionKeyFilePath = path.join(temporaryRoot, 'data-encryption.key');
    fs.mkdirSync(localDirectoryOne, { recursive: true });
    fs.mkdirSync(localDirectoryTwo, { recursive: true });
    fs.mkdirSync(dataDirectory, { recursive: true });
    fs.writeFileSync(encryptionKeyFilePath, 'unit-test-master-encryption-key-at-least-32-bytes\n', 'utf8');
  });

  after(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it('normalizes remote paths and allows Proton Drive root /', () => {
    assert.equal(normalizeRemoteDirectory('/'), '/');
    assert.equal(normalizeRemoteDirectory('///'), '/');
    assert.equal(normalizeRemoteDirectory('/Backups/Docs/'), '/Backups/Docs');
    assert.equal(normalizeRemoteDirectory('/Backups//Sub/../Docs/'), '/Backups/Docs');
    assert.throws(() => normalizeRemoteDirectory('Backups/Docs'), /must be an absolute remote path/);
  });

  it('splits mapping specifications safely including paths containing colons', () => {
    assert.deepEqual(splitMappingSpecification('/mnt/a:/Backups/A'), {
      localDirectory: '/mnt/a',
      remoteDirectory: '/Backups/A',
    });
    assert.deepEqual(splitMappingSpecification('/mnt/foo:bar:/Backups/Colon'), {
      localDirectory: '/mnt/foo:bar',
      remoteDirectory: '/Backups/Colon',
    });
    assert.deepEqual(splitMappingSpecification('C:\\Users\\Docs:/Backups/Docs'), {
      localDirectory: 'C:\\Users\\Docs',
      remoteDirectory: '/Backups/Docs',
    });
    assert.throws(() => splitMappingSpecification('invalid-without-colon'), /Invalid mapping specification/);
  });

  it('parses multiple --map CLI mappings, excludes, dry-run, and delete-empty-dirs', () => {
    const configuration = parseApplicationConfiguration({
      argv: [
        '--map',
        `${localDirectoryOne}:/Backups/One/`,
        '--map',
        `${localDirectoryTwo}:/Backups/Two`,
        '--exclude',
        '*.tmp',
        '--exclude',
        '.DS_Store',
        '--dry-run',
        '--delete-empty-dirs',
        '--no-trash',
        '--encryption-key-file',
        encryptionKeyFilePath,
      ],
      environmentVariables: {},
      defaultDataDirectory: dataDirectory,
    });

    assert.equal(configuration.command, 'sync');
    assert.equal(configuration.dryRun, true);
    assert.ok(configuration.dataEncryptionKey);
    assert.equal(configuration.allowPlaintextState, false);
    assert.equal(configuration.mappings.length, 2);
    assert.deepEqual(configuration.mappings[0], {
      localDirectory: localDirectoryOne,
      remoteDirectory: '/Backups/One',
      excludePatterns: ['*.tmp', '.DS_Store'],
      trashObsolete: false,
      deleteEmptyRemoteDirectories: true,
    });
    assert.deepEqual(configuration.mappings[1], {
      localDirectory: localDirectoryTwo,
      remoteDirectory: '/Backups/Two',
      excludePatterns: ['*.tmp', '.DS_Store'],
      trashObsolete: false,
      deleteEmptyRemoteDirectories: true,
    });
  });

  it('parses SYNC_MAPPINGS both as delimited string and as JSON array', () => {
    const delimitedConfig = parseApplicationConfiguration({
      argv: [],
      environmentVariables: {
        SYNC_MAPPINGS: `${localDirectoryOne}:/R1; ${localDirectoryTwo}:/R2`,
        EXCLUDE_PATTERNS: '*.bak, .git/',
        DATA_ENCRYPTION_KEY_FILE: encryptionKeyFilePath,
      },
      defaultDataDirectory: dataDirectory,
    });

    assert.equal(delimitedConfig.mappings.length, 2);
    assert.equal(delimitedConfig.mappings[0]?.remoteDirectory, '/R1');
    assert.equal(delimitedConfig.mappings[1]?.remoteDirectory, '/R2');
    assert.deepEqual(delimitedConfig.mappings[0]?.excludePatterns, ['*.bak', '.git/']);

    const jsonConfig = parseApplicationConfiguration({
      argv: [],
      environmentVariables: {
        DATA_ENCRYPTION_KEY_FILE: encryptionKeyFilePath,
        SYNC_MAPPINGS: JSON.stringify([
          {
            localDir: localDirectoryOne,
            remoteDir: '/JsonOne',
            exclude: ['cache/'],
            trashObsolete: false,
          },
          {
            localDirectory: localDirectoryTwo,
            remoteDirectory: '/JsonTwo',
            deleteEmptyRemoteDirectories: true,
          },
        ]),
      },
      defaultDataDirectory: dataDirectory,
    });

    assert.equal(jsonConfig.mappings.length, 2);
    assert.equal(jsonConfig.mappings[0]?.trashObsolete, false);
    assert.deepEqual(jsonConfig.mappings[0]?.excludePatterns, ['cache/']);
    assert.equal(jsonConfig.mappings[1]?.deleteEmptyRemoteDirectories, true);
  });

  it('parses YAML configuration files and merges CLI overrides cleanly', () => {
    const yamlFilePath = path.join(temporaryRoot, 'config.yaml');
    fs.writeFileSync(
      yamlFilePath,
      [
        'dryRun: false',
        'deleteEmptyRemoteDirectories: true',
        `encryptionKeyFile: "${encryptionKeyFilePath}"`,
        'exclude:',
        '  - ".DS_Store"',
        'mappings:',
        `  - localDirectory: "${localDirectoryOne}"`,
        '    remoteDirectory: "/Yaml/One"',
        '    exclude:',
        '      - "*.swp"',
        `  - "${localDirectoryTwo}:/Yaml/Two"`,
      ].join('\n'),
      'utf8',
    );

    const configuration = parseApplicationConfiguration({
      argv: ['--config', yamlFilePath, '--exclude', '*.log', '--dry-run'],
      environmentVariables: {},
      defaultDataDirectory: dataDirectory,
    });

    assert.equal(configuration.dryRun, true);
    assert.ok(configuration.dataEncryptionKey);
    assert.equal(configuration.mappings.length, 2);
    assert.deepEqual(configuration.mappings[0]?.excludePatterns, ['.DS_Store', '*.log', '*.swp']);
    assert.equal(configuration.mappings[0]?.deleteEmptyRemoteDirectories, true);
    assert.equal(configuration.mappings[1]?.remoteDirectory, '/Yaml/Two');
  });

  it('supports legacy positional, --local-dir/--remote-dir, and LOCAL_DIR/REMOTE_DIR formats', () => {
    const positionalConfig = parseApplicationConfiguration({
      argv: [localDirectoryOne, '/LegacyPos', '--encryption-key-file', encryptionKeyFilePath],
      environmentVariables: {},
      defaultDataDirectory: dataDirectory,
    });
    assert.equal(positionalConfig.mappings[0]?.localDirectory, localDirectoryOne);
    assert.equal(positionalConfig.mappings[0]?.remoteDirectory, '/LegacyPos');

    const mixedConfig = parseApplicationConfiguration({
      argv: ['--local-dir', localDirectoryOne, '/MixedPos', '--allow-plaintext-state'],
      environmentVariables: {},
      defaultDataDirectory: dataDirectory,
    });
    assert.equal(mixedConfig.mappings[0]?.remoteDirectory, '/MixedPos');
    assert.equal(mixedConfig.allowPlaintextState, true);

    const envConfig = parseApplicationConfiguration({
      argv: [],
      environmentVariables: {
        LOCAL_DIR: localDirectoryTwo,
        REMOTE_DIR: '/LegacyEnv',
        ALLOW_PLAINTEXT_STATE: 'true',
      },
      defaultDataDirectory: dataDirectory,
    });
    assert.equal(envConfig.mappings[0]?.localDirectory, localDirectoryTwo);
    assert.equal(envConfig.mappings[0]?.remoteDirectory, '/LegacyEnv');
    assert.equal(envConfig.allowPlaintextState, true);
  });

  it('reads Docker/Podman *_FILE secret files while trimming single trailing newlines', () => {
    const secretFilePath = path.join(temporaryRoot, 'proton_password.txt');
    fs.writeFileSync(secretFilePath, 'super-secret-value\n', 'utf8');

    const resolvedSecret = readSecretOrEnvironmentVariable(
      {
        PROTON_PASSWORD: 'ignored-fallback',
        PROTON_PASSWORD_FILE: secretFilePath,
      },
      'PROTON_PASSWORD',
    );
    assert.equal(resolvedSecret, 'super-secret-value');
  });

  it('rejects missing local directories, overlapping remote targets, and handles login/help commands', () => {
    assert.throws(
      () =>
        parseApplicationConfiguration({
          argv: [
            '--map',
            `${path.join(temporaryRoot, 'does-not-exist')}:/Remote`,
            '--encryption-key-file',
            encryptionKeyFilePath,
          ],
          environmentVariables: {},
          defaultDataDirectory: dataDirectory,
        }),
      /Local directory does not exist/,
    );

    assert.throws(
      () =>
        parseApplicationConfiguration({
          argv: [
            '--map',
            `${localDirectoryOne}:/Backups/Parent`,
            '--map',
            `${localDirectoryTwo}:/Backups/Parent/Child`,
            '--encryption-key-file',
            encryptionKeyFilePath,
          ],
          environmentVariables: {},
          defaultDataDirectory: dataDirectory,
        }),
      /Overlapping remoteDirectory paths/,
    );

    const loginConfig = parseApplicationConfiguration({
      argv: [
        'login',
        '--session-file',
        path.join(dataDirectory, 'custom-session.json'),
        '--encryption-key-file',
        encryptionKeyFilePath,
      ],
      environmentVariables: {},
      defaultDataDirectory: dataDirectory,
    });
    assert.equal(loginConfig.command, 'login');
    assert.equal(loginConfig.mappings.length, 0);
    assert.equal(loginConfig.sessionFilePath, path.join(dataDirectory, 'custom-session.json'));

    const helpConfig = parseApplicationConfiguration({
      argv: ['--help'],
      environmentVariables: {},
    });
    assert.equal(helpConfig.command, 'help');
  });

  it('parses concurrency and small-file upload options with validation', () => {
    const configuredFromFlags = parseApplicationConfiguration({
      argv: [
        '--map',
        `${localDirectoryOne}:/PerfOne`,
        '--concurrency',
        '7',
        '--small-file-upload',
        '--encryption-key-file',
        encryptionKeyFilePath,
      ],
      environmentVariables: {
        LOCAL_HASH_CONCURRENCY: '12',
        REMOTE_SCAN_CONCURRENCY: '9',
      },
      defaultDataDirectory: dataDirectory,
    });

    assert.equal(configuredFromFlags.uploadConcurrency, 7);
    assert.equal(configuredFromFlags.localHashConcurrency, 12);
    assert.equal(configuredFromFlags.remoteScanConcurrency, 9);
    assert.equal(configuredFromFlags.enableSmallFileUpload, true);

    const yamlConfigPath = path.join(temporaryRoot, 'perf-config.yaml');
    fs.writeFileSync(
      yamlConfigPath,
      [
        'uploadConcurrency: 3',
        'localHashConcurrency: 4',
        'remoteScanConcurrency: 2',
        'enableSmallFileUpload: true',
        'allowPlaintextState: true',
        'mappings:',
        `  - "${localDirectoryOne}:/YamlPerf"`,
      ].join('\n'),
      'utf8',
    );

    const configuredFromYaml = parseApplicationConfiguration({
      argv: ['--config', yamlConfigPath],
      environmentVariables: {},
      defaultDataDirectory: dataDirectory,
    });
    assert.equal(configuredFromYaml.uploadConcurrency, 3);
    assert.equal(configuredFromYaml.localHashConcurrency, 4);
    assert.equal(configuredFromYaml.remoteScanConcurrency, 2);
    assert.equal(configuredFromYaml.enableSmallFileUpload, true);

    assert.throws(
      () =>
        parseApplicationConfiguration({
          argv: [
            '--map',
            `${localDirectoryOne}:/BadConcurrency`,
            '--concurrency',
            '99',
            '--encryption-key-file',
            encryptionKeyFilePath,
          ],
          environmentVariables: {},
          defaultDataDirectory: dataDirectory,
        }),
      /Option --concurrency must be an integer between 1 and 32/,
    );
  });

  it('enforces mandatory at-rest encryption key file policy and rejects raw DATA_ENCRYPTION_KEY env vars', () => {
    assert.throws(
      () =>
        parseApplicationConfiguration({
          argv: ['--map', `${localDirectoryOne}:/MissingKey`],
          environmentVariables: {},
          defaultDataDirectory: dataDirectory,
        }),
      /At-rest encryption key is required/,
    );

    assert.throws(
      () =>
        parseApplicationConfiguration({
          argv: ['login'],
          environmentVariables: {},
          defaultDataDirectory: dataDirectory,
        }),
      /At-rest encryption key is required/,
    );

    assert.throws(
      () =>
        parseApplicationConfiguration({
          argv: ['--map', `${localDirectoryOne}:/RawEnvRejected`],
          environmentVariables: {
            DATA_ENCRYPTION_KEY: 'raw-env-key-should-be-blocked-for-docker-inspect-safety',
          },
          defaultDataDirectory: dataDirectory,
        }),
      /DATA_ENCRYPTION_KEY environment variable is not supported/,
    );

    const shortKeyPath = path.join(temporaryRoot, 'short.key');
    fs.writeFileSync(shortKeyPath, 'short-key\n', 'utf8');
    assert.throws(
      () =>
        parseApplicationConfiguration({
          argv: [
            '--map',
            `${localDirectoryOne}:/ShortKey`,
            '--encryption-key-file',
            shortKeyPath,
          ],
          environmentVariables: {},
          defaultDataDirectory: dataDirectory,
        }),
      /too short/,
    );

    assert.throws(
      () =>
        parseApplicationConfiguration({
          argv: [
            '--map',
            `${localDirectoryOne}:/MissingFile`,
            '--encryption-key-file',
            path.join(temporaryRoot, 'nonexistent.key'),
          ],
          environmentVariables: {},
          defaultDataDirectory: dataDirectory,
        }),
      /Encryption key file does not exist/,
    );
  });

  it('parses verbose option across CLI flag, environment variable, and YAML configuration with validation', () => {
    const defaultConfiguration = parseApplicationConfiguration({
      argv: ['--map', `${localDirectoryOne}:/VerboseDefault`, '--allow-plaintext-state'],
      environmentVariables: {},
      defaultDataDirectory: dataDirectory,
    });
    assert.equal(defaultConfiguration.verbose, false);

    const cliVerboseConfiguration = parseApplicationConfiguration({
      argv: ['--map', `${localDirectoryOne}:/VerboseCli`, '-v', '--allow-plaintext-state'],
      environmentVariables: {},
      defaultDataDirectory: dataDirectory,
    });
    assert.equal(cliVerboseConfiguration.verbose, true);

    const environmentVerboseConfiguration = parseApplicationConfiguration({
      argv: [],
      environmentVariables: {
        SYNC_MAPPINGS: `${localDirectoryOne}:/VerboseEnv`,
        VERBOSE: 'true',
        ALLOW_PLAINTEXT_STATE: 'true',
      },
      defaultDataDirectory: dataDirectory,
    });
    assert.equal(environmentVerboseConfiguration.verbose, true);

    const yamlVerbosePath = path.join(temporaryRoot, 'verbose-config.yaml');
    fs.writeFileSync(
      yamlVerbosePath,
      ['verbose: true', 'allowPlaintextState: true', 'mappings:', `  - "${localDirectoryOne}:/VerboseYaml"`].join(
        '\n',
      ),
      'utf8',
    );
    const yamlVerboseConfiguration = parseApplicationConfiguration({
      argv: ['--config', yamlVerbosePath],
      environmentVariables: {},
      defaultDataDirectory: dataDirectory,
    });
    assert.equal(yamlVerboseConfiguration.verbose, true);

    const invalidVerboseYamlPath = path.join(temporaryRoot, 'invalid-verbose-config.yaml');
    fs.writeFileSync(
      invalidVerboseYamlPath,
      ['verbose: "yes"', 'allowPlaintextState: true', 'mappings:', `  - "${localDirectoryOne}:/BadVerboseYaml"`].join(
        '\n',
      ),
      'utf8',
    );
    assert.throws(
      () =>
        parseApplicationConfiguration({
          argv: ['--config', invalidVerboseYamlPath],
          environmentVariables: {},
          defaultDataDirectory: dataDirectory,
        }),
      /Configuration field "verbose" must be a boolean/,
    );
  });

  it('parses status file, status-server, and report-failure configuration across CLI, env, and YAML', () => {
    const defaultStatusConfig = parseApplicationConfiguration({
      argv: ['--map', `${localDirectoryOne}:/StatusDefault`, '--allow-plaintext-state'],
      environmentVariables: {},
      defaultDataDirectory: dataDirectory,
    });
    assert.equal(defaultStatusConfig.statusFilePath, path.join(dataDirectory, 'status.json'));
    assert.equal(defaultStatusConfig.statusServerHost, '0.0.0.0');
    assert.equal(defaultStatusConfig.statusServerPort, 9108);
    assert.equal(defaultStatusConfig.statusMaxAgeHours, 26);
    assert.equal(defaultStatusConfig.statusTriggerFilePath, undefined);
    assert.equal(defaultStatusConfig.statusTriggerToken, undefined);
    assert.equal(defaultStatusConfig.allowUnauthenticatedTrigger, false);
    assert.equal(defaultStatusConfig.statusTriggerCooldownSeconds, 900);

    const customStateDirectory = path.join(temporaryRoot, 'custom-state-dir');
    const derivedStatusConfig = parseApplicationConfiguration({
      argv: [
        '--map',
        `${localDirectoryOne}:/StatusDerived`,
        '--state-file',
        path.join(customStateDirectory, 'remote-state.json'),
        '--allow-plaintext-state',
      ],
      environmentVariables: {},
      defaultDataDirectory: dataDirectory,
    });
    assert.equal(derivedStatusConfig.statusFilePath, path.join(customStateDirectory, 'status.json'));

    const statusServerCliConfig = parseApplicationConfiguration({
      argv: [
        'status-server',
        '--status-file',
        path.join(temporaryRoot, 'cli-status.json'),
        '--status-host',
        '127.0.0.1',
        '--status-port',
        '9200',
        '--status-max-age-hours',
        '12.5',
      ],
      environmentVariables: {},
      defaultDataDirectory: dataDirectory,
    });
    assert.equal(statusServerCliConfig.command, 'status-server');
    assert.equal(statusServerCliConfig.mappings.length, 0);
    assert.equal(statusServerCliConfig.statusFilePath, path.join(temporaryRoot, 'cli-status.json'));
    assert.equal(statusServerCliConfig.statusServerHost, '127.0.0.1');
    assert.equal(statusServerCliConfig.statusServerPort, 9200);
    assert.equal(statusServerCliConfig.statusMaxAgeHours, 12.5);

    const statusServerEnvConfig = parseApplicationConfiguration({
      argv: ['status-server'],
      environmentVariables: {
        STATUS_FILE: path.join(temporaryRoot, 'env-status.json'),
        STATUS_SERVER_HOST: '192.168.1.10',
        STATUS_SERVER_PORT: '9300',
        STATUS_MAX_AGE_HOURS: '30',
      },
      defaultDataDirectory: dataDirectory,
    });
    assert.equal(statusServerEnvConfig.statusFilePath, path.join(temporaryRoot, 'env-status.json'));
    assert.equal(statusServerEnvConfig.statusServerHost, '192.168.1.10');
    assert.equal(statusServerEnvConfig.statusServerPort, 9300);
    assert.equal(statusServerEnvConfig.statusMaxAgeHours, 30);

    const yamlStatusPath = path.join(temporaryRoot, 'status-config.yaml');
    fs.writeFileSync(
      yamlStatusPath,
      [
        'statusFile: ' + path.join(temporaryRoot, 'yaml-status.json'),
        'statusServerHost: "10.0.0.5"',
        'statusServerPort: 9400',
        'statusMaxAgeHours: 48',
        'allowPlaintextState: true',
        'mappings:',
        `  - "${localDirectoryOne}:/StatusYaml"`,
      ].join('\n'),
      'utf8',
    );
    const yamlStatusConfig = parseApplicationConfiguration({
      argv: ['status-server', '--config', yamlStatusPath],
      environmentVariables: {},
      defaultDataDirectory: dataDirectory,
    });
    assert.equal(yamlStatusConfig.statusFilePath, path.join(temporaryRoot, 'yaml-status.json'));
    assert.equal(yamlStatusConfig.statusServerHost, '10.0.0.5');
    assert.equal(yamlStatusConfig.statusServerPort, 9400);
    assert.equal(yamlStatusConfig.statusMaxAgeHours, 48);

    const reportFailureFlagConfig = parseApplicationConfiguration({
      argv: ['report-failure', '--message', 'Paperless document_exporter exited 1'],
      environmentVariables: {},
      defaultDataDirectory: dataDirectory,
    });
    assert.equal(reportFailureFlagConfig.command, 'report-failure');
    assert.equal(reportFailureFlagConfig.failureMessage, 'Paperless document_exporter exited 1');

    const reportFailurePositionalConfig = parseApplicationConfiguration({
      argv: ['report-failure', 'External', 'pre-sync', 'failed'],
      environmentVariables: {},
      defaultDataDirectory: dataDirectory,
    });
    assert.equal(reportFailurePositionalConfig.failureMessage, 'External pre-sync failed');

    assert.throws(
      () =>
        parseApplicationConfiguration({
          argv: ['report-failure'],
          environmentVariables: {},
          defaultDataDirectory: dataDirectory,
        }),
      /Missing failure message/,
    );

    assert.throws(
      () =>
        parseApplicationConfiguration({
          argv: ['status-server', '--status-port', '70000'],
          environmentVariables: {},
          defaultDataDirectory: dataDirectory,
        }),
      /between 1 and 65535/,
    );

    assert.throws(
      () =>
        parseApplicationConfiguration({
          argv: ['status-server', '--status-max-age-hours', '0'],
          environmentVariables: {},
          defaultDataDirectory: dataDirectory,
        }),
      /greater than 0/,
    );
  });

  it('parses and validates status-server trigger file, bearer token file, opt-out, and cooldown options', () => {
    const triggerFilePath = path.join(temporaryRoot, 'trigger', 'backup.trigger');
    const triggerTokenFilePath = path.join(temporaryRoot, 'status-trigger.token');
    fs.writeFileSync(triggerTokenFilePath, 'unit-test-trigger-bearer-token-at-least-32-bytes\n', 'utf8');

    // CLI precedence over environment variables and YAML.
    const cliTriggerTokenFilePath = path.join(temporaryRoot, 'cli-trigger.token');
    fs.writeFileSync(cliTriggerTokenFilePath, 'cli-override-trigger-bearer-token-at-least-32-bytes\n', 'utf8');
    const yamlTriggerConfigPath = path.join(temporaryRoot, 'trigger-config.yaml');
    fs.writeFileSync(
      yamlTriggerConfigPath,
      [
        `statusTriggerFile: "${path.join(temporaryRoot, 'yaml.trigger')}"`,
        `statusTriggerTokenFile: "${triggerTokenFilePath}"`,
        'statusTriggerCooldownSeconds: 300',
        'allowUnauthenticatedTrigger: false',
        'allowPlaintextState: true',
        'mappings:',
        `  - "${localDirectoryOne}:/TriggerYaml"`,
      ].join('\n'),
      'utf8',
    );

    const cliTriggerConfiguration = parseApplicationConfiguration({
      argv: [
        'status-server',
        '--config',
        yamlTriggerConfigPath,
        '--trigger-file',
        triggerFilePath,
        '--trigger-token-file',
        cliTriggerTokenFilePath,
        '--trigger-cooldown-seconds',
        '0',
      ],
      environmentVariables: {
        STATUS_TRIGGER_FILE: path.join(temporaryRoot, 'env.trigger'),
        STATUS_TRIGGER_TOKEN_FILE: triggerTokenFilePath,
        STATUS_TRIGGER_COOLDOWN_SECONDS: '120',
      },
      defaultDataDirectory: dataDirectory,
    });
    assert.equal(cliTriggerConfiguration.statusTriggerFilePath, triggerFilePath);
    assert.equal(
      cliTriggerConfiguration.statusTriggerToken?.toString('utf8'),
      'cli-override-trigger-bearer-token-at-least-32-bytes',
    );
    assert.equal(cliTriggerConfiguration.statusTriggerCooldownSeconds, 0);
    assert.equal(cliTriggerConfiguration.allowUnauthenticatedTrigger, false);

    // Environment variable precedence over YAML.
    const environmentTriggerConfiguration = parseApplicationConfiguration({
      argv: ['status-server', '--config', yamlTriggerConfigPath],
      environmentVariables: {
        STATUS_TRIGGER_FILE: path.join(temporaryRoot, 'env.trigger'),
        STATUS_TRIGGER_TOKEN_FILE: triggerTokenFilePath,
        STATUS_TRIGGER_COOLDOWN_SECONDS: '180',
      },
      defaultDataDirectory: dataDirectory,
    });
    assert.equal(
      environmentTriggerConfiguration.statusTriggerFilePath,
      path.join(temporaryRoot, 'env.trigger'),
    );
    assert.equal(
      environmentTriggerConfiguration.statusTriggerToken?.toString('utf8'),
      'unit-test-trigger-bearer-token-at-least-32-bytes',
    );
    assert.equal(environmentTriggerConfiguration.statusTriggerCooldownSeconds, 180);

    // YAML configuration values apply when CLI and environment omit overrides.
    const yamlTriggerConfiguration = parseApplicationConfiguration({
      argv: ['status-server', '--config', yamlTriggerConfigPath],
      environmentVariables: {},
      defaultDataDirectory: dataDirectory,
    });
    assert.equal(
      yamlTriggerConfiguration.statusTriggerFilePath,
      path.join(temporaryRoot, 'yaml.trigger'),
    );
    assert.equal(yamlTriggerConfiguration.statusTriggerCooldownSeconds, 300);

    // Unauthenticated opt-out works when explicitly requested.
    const unauthenticatedTriggerConfiguration = parseApplicationConfiguration({
      argv: [
        'status-server',
        '--trigger-file',
        triggerFilePath,
        '--allow-unauthenticated-trigger',
      ],
      environmentVariables: {},
      defaultDataDirectory: dataDirectory,
    });
    assert.equal(unauthenticatedTriggerConfiguration.allowUnauthenticatedTrigger, true);
    assert.equal(unauthenticatedTriggerConfiguration.statusTriggerToken, undefined);

    // Shared YAML referencing a non-existent trigger token file still works for sync, login, and report-failure.
    const sharedYamlConfigPath = path.join(temporaryRoot, 'shared-trigger-config.yaml');
    fs.writeFileSync(
      sharedYamlConfigPath,
      [
        `statusTriggerFile: "${triggerFilePath}"`,
        `statusTriggerTokenFile: "${path.join(temporaryRoot, 'not-mounted-in-sync-container.token')}"`,
        'allowPlaintextState: true',
        'mappings:',
        `  - "${localDirectoryOne}:/SharedTrigger"`,
      ].join('\n'),
      'utf8',
    );
    const syncWithSharedYaml = parseApplicationConfiguration({
      argv: ['--config', sharedYamlConfigPath],
      environmentVariables: {},
      defaultDataDirectory: dataDirectory,
    });
    assert.equal(syncWithSharedYaml.command, 'sync');
    assert.equal(syncWithSharedYaml.statusTriggerToken, undefined);

    const loginWithSharedYaml = parseApplicationConfiguration({
      argv: ['login', '--config', sharedYamlConfigPath],
      environmentVariables: {},
      defaultDataDirectory: dataDirectory,
    });
    assert.equal(loginWithSharedYaml.command, 'login');

    const reportFailureWithSharedYaml = parseApplicationConfiguration({
      argv: ['report-failure', '--config', sharedYamlConfigPath, '--message', 'Pre-sync failed'],
      environmentVariables: {},
      defaultDataDirectory: dataDirectory,
    });
    assert.equal(reportFailureWithSharedYaml.command, 'report-failure');

    // Fail-fast when status-server configures --trigger-file without token or opt-out.
    assert.throws(
      () =>
        parseApplicationConfiguration({
          argv: ['status-server', '--trigger-file', triggerFilePath],
          environmentVariables: {},
          defaultDataDirectory: dataDirectory,
        }),
      /Trigger bearer token is required/,
    );

    // Reject raw STATUS_TRIGGER_TOKEN environment variable.
    assert.throws(
      () =>
        parseApplicationConfiguration({
          argv: ['status-server', '--trigger-file', triggerFilePath],
          environmentVariables: {
            STATUS_TRIGGER_TOKEN: 'raw-env-token-should-be-blocked-for-container-inspect-safety',
          },
          defaultDataDirectory: dataDirectory,
        }),
      /STATUS_TRIGGER_TOKEN environment variable is not supported/,
    );

    // Reject missing, short, and whitespace-containing token files.
    assert.throws(
      () =>
        parseApplicationConfiguration({
          argv: [
            'status-server',
            '--trigger-file',
            triggerFilePath,
            '--trigger-token-file',
            path.join(temporaryRoot, 'missing.token'),
          ],
          environmentVariables: {},
          defaultDataDirectory: dataDirectory,
        }),
      /Trigger token file does not exist/,
    );

    const shortTriggerTokenPath = path.join(temporaryRoot, 'short.token');
    fs.writeFileSync(shortTriggerTokenPath, 'too-short\n', 'utf8');
    assert.throws(
      () =>
        parseApplicationConfiguration({
          argv: [
            'status-server',
            '--trigger-file',
            triggerFilePath,
            '--trigger-token-file',
            shortTriggerTokenPath,
          ],
          environmentVariables: {},
          defaultDataDirectory: dataDirectory,
        }),
      /too short/,
    );

    const whitespaceTriggerTokenPath = path.join(temporaryRoot, 'whitespace.token');
    fs.writeFileSync(
      whitespaceTriggerTokenPath,
      'token with spaces cannot be used cleanly in bearer auth header\n',
      'utf8',
    );
    assert.throws(
      () =>
        parseApplicationConfiguration({
          argv: [
            'status-server',
            '--trigger-file',
            triggerFilePath,
            '--trigger-token-file',
            whitespaceTriggerTokenPath,
          ],
          environmentVariables: {},
          defaultDataDirectory: dataDirectory,
        }),
      /single-line secret without embedded spaces/,
    );

    // Reject collisions with statusFile, sessionFile, and stateFile.
    const statusPath = path.join(dataDirectory, 'status.json');
    const sessionPath = path.join(dataDirectory, 'session.json');
    const statePath = path.join(dataDirectory, 'state.json');
    for (const collidingPath of [statusPath, sessionPath, statePath]) {
      assert.throws(
        () =>
          parseApplicationConfiguration({
            argv: [
              'status-server',
              '--trigger-file',
              collidingPath,
              '--allow-unauthenticated-trigger',
            ],
            environmentVariables: {},
            defaultDataDirectory: dataDirectory,
          }),
        /must be distinct from statusFile, sessionFile, and stateFile/,
      );
    }

    // Reject out-of-range or non-integer cooldown values.
    for (const invalidCooldownFlag of [
      '--trigger-cooldown-seconds=-1',
      '--trigger-cooldown-seconds=604801',
      '--trigger-cooldown-seconds=abc',
    ]) {
      assert.throws(
        () =>
          parseApplicationConfiguration({
            argv: ['status-server', invalidCooldownFlag],
            environmentVariables: {},
            defaultDataDirectory: dataDirectory,
          }),
        /--trigger-cooldown-seconds/,
      );
    }

    assert.throws(
      () =>
        parseApplicationConfiguration({
          argv: ['status-server'],
          environmentVariables: {
            STATUS_TRIGGER_COOLDOWN_SECONDS: '-1',
          },
          defaultDataDirectory: dataDirectory,
        }),
      /STATUS_TRIGGER_COOLDOWN_SECONDS/,
    );
  });

  it('parses home-assistant-config strictly from CLI flags and ignores env vars and CONFIG_FILE', () => {
    const defaultHaConfig = parseApplicationConfiguration({
      argv: ['home-assistant-config'],
      environmentVariables: {
        VERBOSE: 'true',
        ALLOW_UNAUTHENTICATED_TRIGGER: 'true',
        STATUS_TRIGGER_FILE: '/should/be/ignored.trigger',
        DATA_ENCRYPTION_KEY: 'should-be-ignored-in-generator-mode',
        STATUS_TRIGGER_TOKEN: 'should-be-ignored-in-generator-mode',
        CONFIG_FILE: path.join(temporaryRoot, 'nonexistent-config.yaml'),
      },
      defaultDataDirectory: dataDirectory,
    });

    assert.equal(defaultHaConfig.command, 'home-assistant-config');
    assert.equal(defaultHaConfig.verbose, false);
    assert.deepEqual(defaultHaConfig.homeAssistantConfig, {
      prefix: undefined,
      statusServerBaseUrl: 'http://192.168.1.50:9108',
      scanIntervalSeconds: 300,
      includeTrigger: true,
      allowUnauthenticatedTrigger: false,
      outputFilePath: undefined,
    });

    const outputPath = path.join(temporaryRoot, 'packages', 'paperless.yaml');
    const customizedHaConfig = parseApplicationConfiguration({
      argv: [
        'home-assistant-config',
        '--prefix',
        'Paperless',
        '--status-url',
        'https://backup.local/status-api/',
        '--scan-interval',
        '120',
        '--no-trigger',
        '--allow-unauthenticated-trigger',
        '-o',
        outputPath,
      ],
      environmentVariables: {},
      defaultDataDirectory: dataDirectory,
    });

    assert.equal(customizedHaConfig.command, 'home-assistant-config');
    assert.deepEqual(customizedHaConfig.homeAssistantConfig, {
      prefix: 'Paperless',
      statusServerBaseUrl: 'https://backup.local/status-api',
      scanIntervalSeconds: 120,
      includeTrigger: false,
      allowUnauthenticatedTrigger: true,
      outputFilePath: outputPath,
    });

    assert.throws(
      () =>
        parseApplicationConfiguration({
          argv: ['home-assistant-config', 'Paperless'],
          environmentVariables: {},
        }),
      /Unexpected positional argument/,
    );

    assert.throws(
      () =>
        parseApplicationConfiguration({
          argv: ['home-assistant-config', '--output', '   '],
          environmentVariables: {},
        }),
      /Option --output cannot be empty/,
    );

    assert.throws(
      () =>
        parseApplicationConfiguration({
          argv: ['home-assistant-config', '--prefix', 'bad/prefix'],
          environmentVariables: {},
        }),
      /Invalid Home Assistant prefix/,
    );

    assert.throws(
      () =>
        parseApplicationConfiguration({
          argv: ['home-assistant-config', '--status-url', 'ftp://192.168.1.50:9108'],
          environmentVariables: {},
        }),
      /Only http:\/\/ and https:\/\//,
    );

    assert.throws(
      () =>
        parseApplicationConfiguration({
          argv: ['home-assistant-config', '--scan-interval', '5'],
          environmentVariables: {},
        }),
      /between 10 and 86400/,
    );
  });
});
