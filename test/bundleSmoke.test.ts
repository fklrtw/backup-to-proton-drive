import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fileSystem from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';

const execFileAsync = promisify(execFile);

describe('bundled CLI smoke test', () => {
  it('loads the bundled ESM executable with --help and exits cleanly', async () => {
    const bundlePath = path.resolve('dist', 'index.js');
    const { stdout, stderr } = await execFileAsync(process.execPath, [bundlePath, '--help']);
    assert.equal(stderr, '');
    assert.match(stdout, /backup-to-proton-drive login/);
    assert.match(stdout, /backup-to-proton-drive status-server/);
    assert.match(stdout, /backup-to-proton-drive report-failure/);
    assert.match(stdout, /backup-to-proton-drive home-assistant-config/);
    assert.match(stdout, /--trigger-file/);
    assert.match(stdout, /--trigger-token-file/);
    assert.match(stdout, /--allow-unauthenticated-trigger/);
    assert.match(stdout, /--trigger-cooldown-seconds/);
    assert.match(stdout, /--prefix/);
    assert.match(stdout, /--status-url/);
    assert.match(stdout, /--scan-interval/);
    assert.match(stdout, /--no-trigger/);
    assert.match(stdout, /--output/);
    assert.match(stdout, /STATUS_TRIGGER_FILE/);
    assert.match(stdout, /STATUS_TRIGGER_TOKEN_FILE/);
    assert.match(stdout, /STATUS_TRIGGER_COOLDOWN_SECONDS/);
    assert.match(stdout, /SYNC_MAPPINGS/);
  });

  it('exits with code 1 and clear error message when no mappings are configured', async () => {
    const bundlePath = path.resolve('dist', 'index.js');
    await assert.rejects(
      () =>
        execFileAsync(process.execPath, [bundlePath], {
          env: { PATH: process.env.PATH ?? '' },
        }),
      (executionError: unknown) => {
        const typedError = executionError as { code?: number; stderr?: string };
        assert.equal(typedError.code, 1);
        assert.match(typedError.stderr ?? '', /No directory mappings configured/);
        return true;
      },
    );
  });

  it('fails fast with code 1 when mappings exist without DATA_ENCRYPTION_KEY_FILE or --allow-plaintext-state', async () => {
    const bundlePath = path.resolve('dist', 'index.js');
    const nonexistentSessionPath = path.join(os.tmpdir(), `proton-smoke-nokey-${process.pid}.json`);

    await assert.rejects(
      () =>
        execFileAsync(
          process.execPath,
          [bundlePath, '--map', `${os.tmpdir()}:/SmokeTest`, '--session-file', nonexistentSessionPath],
          {
            env: { PATH: process.env.PATH ?? '' },
          },
        ),
      (executionError: unknown) => {
        const typedError = executionError as { code?: number; stderr?: string };
        assert.equal(typedError.code, 1);
        assert.match(typedError.stderr ?? '', /At-rest encryption key is required/);
        return true;
      },
    );
  });

  it('initializes and releases bundled CryptoProxy cleanly before reporting missing session and failure status', async () => {
    const bundlePath = path.resolve('dist', 'index.js');
    const temporaryDirectory = fileSystem.mkdtempSync(path.join(os.tmpdir(), 'proton-smoke-missing-'));
    const nonexistentSessionPath = path.join(temporaryDirectory, 'session.json');
    const stateFilePath = path.join(temporaryDirectory, 'state.json');
    const statusFilePath = path.join(temporaryDirectory, 'status.json');

    try {
      await assert.rejects(
        () =>
          execFileAsync(
            process.execPath,
            [
              bundlePath,
              '--map',
              `${temporaryDirectory}:/SmokeTest`,
              '--allow-plaintext-state',
              '--session-file',
              nonexistentSessionPath,
              '--state-file',
              stateFilePath,
              '--status-file',
              statusFilePath,
            ],
            {
              env: { PATH: process.env.PATH ?? '' },
            },
          ),
        (executionError: unknown) => {
          const typedError = executionError as { code?: number; stderr?: string };
          assert.equal(typedError.code, 1);
          assert.match(typedError.stderr ?? '', /No valid session found/);
          return true;
        },
      );

      const persistedStatus = JSON.parse(fileSystem.readFileSync(statusFilePath, 'utf8')) as {
        status: string;
        running: boolean;
        errorMessage: string | null;
      };
      assert.equal(persistedStatus.status, 'error');
      assert.equal(persistedStatus.running, false);
      assert.match(persistedStatus.errorMessage ?? '', /No valid session found/);
    } finally {
      fileSystem.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('records external failure telemetry cleanly via bundled report-failure subcommand', async () => {
    const bundlePath = path.resolve('dist', 'index.js');
    const temporaryDirectory = fileSystem.mkdtempSync(path.join(os.tmpdir(), 'proton-smoke-report-'));
    const statusFilePath = path.join(temporaryDirectory, 'status.json');

    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [
          bundlePath,
          'report-failure',
          '--status-file',
          statusFilePath,
          '--message',
          'Paperless exporter failed for operator@example.com',
        ],
        {
          env: { PATH: process.env.PATH ?? '' },
        },
      );
      assert.equal(stderr, '');
      assert.match(stdout, /Recorded failure status/);

      const persistedStatus = JSON.parse(fileSystem.readFileSync(statusFilePath, 'utf8')) as {
        status: string;
        running: boolean;
        errorMessage: string | null;
      };
      assert.equal(persistedStatus.status, 'error');
      assert.equal(persistedStatus.running, false);
      assert.equal(
        persistedStatus.errorMessage,
        'Paperless exporter failed for [REDACTED_EMAIL]',
      );
    } finally {
      fileSystem.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('fails fast on bundled status-server when --trigger-file lacks token file or opt-out', async () => {
    const bundlePath = path.resolve('dist', 'index.js');
    const temporaryDirectory = fileSystem.mkdtempSync(path.join(os.tmpdir(), 'proton-smoke-trigger-'));
    const statusFilePath = path.join(temporaryDirectory, 'status.json');
    const triggerFilePath = path.join(temporaryDirectory, 'backup.trigger');

    try {
      await assert.rejects(
        () =>
          execFileAsync(
            process.execPath,
            [
              bundlePath,
              'status-server',
              '--status-file',
              statusFilePath,
              '--trigger-file',
              triggerFilePath,
            ],
            {
              env: { PATH: process.env.PATH ?? '' },
            },
          ),
        (executionError: unknown) => {
          const typedError = executionError as { code?: number; stderr?: string };
          assert.equal(typedError.code, 1);
          assert.match(typedError.stderr ?? '', /Trigger bearer token is required/);
          return true;
        },
      );
    } finally {
      fileSystem.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('generates clean Home Assistant YAML to stdout and --output via bundled home-assistant-config', async () => {
    const bundlePath = path.resolve('dist', 'index.js');
    const temporaryDirectory = fileSystem.mkdtempSync(path.join(os.tmpdir(), 'proton-smoke-ha-'));
    const outputFilePath = path.join(temporaryDirectory, 'packages', 'photos_proton_backup.yaml');

    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [
          bundlePath,
          'home-assistant-config',
          '--prefix',
          'Paperless',
          '--status-url',
          'http://10.0.0.5:9200',
        ],
        {
          env: {
            PATH: process.env.PATH ?? '',
            VERBOSE: 'true',
            ALLOW_UNAUTHENTICATED_TRIGGER: 'true',
          },
        },
      );
      assert.equal(stderr, '');
      assert.equal(stdout.includes('[verbose]'), false);

      const parsedStdoutYaml = parseYaml(stdout, {
        customTags: [
          {
            tag: '!secret',
            resolve: (secretKey: string) => `__SECRET__:${secretKey}`,
          },
        ],
      }) as {
        rest: Array<{ resource: string; sensor: Array<{ unique_id: string }> }>;
        rest_command?: Record<string, { headers?: { authorization?: string } }>;
      };
      assert.equal(parsedStdoutYaml.rest[0]?.resource, 'http://10.0.0.5:9200/status');
      assert.equal(parsedStdoutYaml.rest[0]?.sensor[0]?.unique_id, 'paperless_proton_backup_status');
      assert.equal(
        parsedStdoutYaml.rest_command?.paperless_proton_backup_trigger?.headers?.authorization,
        '__SECRET__:paperless_proton_backup_trigger_authorization',
      );

      const fileResult = await execFileAsync(
        process.execPath,
        [
          bundlePath,
          'home-assistant-config',
          '--prefix',
          'Photos',
          '--no-trigger',
          '-o',
          outputFilePath,
        ],
        {
          env: { PATH: process.env.PATH ?? '' },
        },
      );
      assert.equal(fileResult.stderr, '');
      assert.match(fileResult.stdout, /Wrote Home Assistant package configuration/);

      const writtenFileContent = fileSystem.readFileSync(outputFilePath, 'utf8');
      assert.equal(writtenFileContent.includes('rest_command:'), false);
      assert.ok(writtenFileContent.includes('unique_id: photos_proton_backup_status'));
    } finally {
      fileSystem.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
