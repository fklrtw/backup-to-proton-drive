import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { computeFileSha1Stream, scanLocalDirectory } from '../src/localScanner.ts';

describe('localScanner', () => {
  let temporaryRoot = '';

  before(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'proton-backup-scanner-test-'));
    fs.mkdirSync(path.join(temporaryRoot, 'sub', 'nested'), { recursive: true });
    fs.mkdirSync(path.join(temporaryRoot, 'ignored_dir'), { recursive: true });
    fs.mkdirSync(path.join(temporaryRoot, 'empty_dir'), { recursive: true });

    fs.writeFileSync(path.join(temporaryRoot, 'alpha.txt'), 'hello proton drive\n', 'utf8');
    fs.writeFileSync(path.join(temporaryRoot, 'sub', 'nested', 'data.bin'), Buffer.from([0, 1, 2, 3, 255]));
    fs.writeFileSync(path.join(temporaryRoot, 'sub', 'scratch.tmp'), 'temporary', 'utf8');
    fs.writeFileSync(path.join(temporaryRoot, 'ignored_dir', 'secret.txt'), 'skip me', 'utf8');

    fs.symlinkSync(
      path.join(temporaryRoot, 'alpha.txt'),
      path.join(temporaryRoot, 'alpha-link.txt'),
    );
  });

  after(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it('computes accurate streaming SHA1 digests matching Node crypto', async () => {
    const filePath = path.join(temporaryRoot, 'alpha.txt');
    const expectedSha1 = crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex');
    const computedSha1 = await computeFileSha1Stream(filePath);
    assert.equal(computedSha1, expectedSha1);
  });

  it('scans regular files recursively, skips symlinks/empty dirs, and honors exclude patterns', async () => {
    const scanResult = await scanLocalDirectory(temporaryRoot, ['*.tmp', 'ignored_dir/']);

    const discoveredRelativePaths = Array.from(scanResult.filesByRelativePath.keys()).sort();
    assert.deepEqual(discoveredRelativePaths, ['alpha.txt', 'sub/nested/data.bin']);
    assert.equal(scanResult.totalSizeInBytes, 19 + 5);

    const nestedFile = scanResult.filesByRelativePath.get('sub/nested/data.bin');
    assert.ok(nestedFile);
    assert.equal(nestedFile.sizeInBytes, 5);
    assert.equal(
      nestedFile.sha1Hash,
      crypto.createHash('sha1').update(Buffer.from([0, 1, 2, 3, 255])).digest('hex'),
    );
  });

  it('aborts cleanly when AbortSignal is triggered', async () => {
    const abortController = new AbortController();
    abortController.abort(new Error('Aborted by test'));

    await assert.rejects(() => scanLocalDirectory(temporaryRoot, [], abortController.signal), /Aborted by test/);
  });

  it('hashes discovered files accurately across custom hashConcurrency values', async () => {
    const sequentialScan = await scanLocalDirectory(temporaryRoot, ['*.tmp', 'ignored_dir/'], undefined, 1);
    const parallelScan = await scanLocalDirectory(temporaryRoot, ['*.tmp', 'ignored_dir/'], undefined, 4);

    assert.equal(parallelScan.totalSizeInBytes, sequentialScan.totalSizeInBytes);
    assert.deepEqual(
      Array.from(parallelScan.filesByRelativePath.entries()),
      Array.from(sequentialScan.filesByRelativePath.entries()),
    );
  });
});
