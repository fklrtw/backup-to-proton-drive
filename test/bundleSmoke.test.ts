import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('bundled CLI smoke test', () => {
  it('loads the bundled ESM executable with --help and exits cleanly', async () => {
    const bundlePath = path.resolve('dist', 'index.js');
    const { stdout, stderr } = await execFileAsync(process.execPath, [bundlePath, '--help']);
    assert.equal(stderr, '');
    assert.match(stdout, /backup-to-proton-drive login/);
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

  it('initializes and releases bundled CryptoProxy cleanly before reporting missing session', async () => {
    const bundlePath = path.resolve('dist', 'index.js');
    const nonexistentSessionPath = path.join(os.tmpdir(), `proton-smoke-missing-${process.pid}.json`);

    await assert.rejects(
      () =>
        execFileAsync(
          process.execPath,
          [
            bundlePath,
            '--map',
            `${os.tmpdir()}:/SmokeTest`,
            '--allow-plaintext-state',
            '--session-file',
            nonexistentSessionPath,
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
  });
});
