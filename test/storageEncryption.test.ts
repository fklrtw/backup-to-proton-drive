import assert from 'node:assert/strict';
import * as fileSystem from 'node:fs';
import * as operatingSystem from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { loadSessionData, saveSessionData } from '../src/proton/sessionStore.ts';
import {
  decryptJsonPayload,
  encryptJsonPayload,
  MINIMUM_ENCRYPTION_KEY_BYTE_LENGTH,
  readProtectedJsonFile,
  type StorageEncryptionOptions,
  validateEncryptionKeyMaterial,
  writeProtectedJsonFile,
} from '../src/storageEncryption.ts';
import type { PersistedSessionData } from '../src/types.ts';

describe('storageEncryption', () => {
  let temporaryRootDirectory = '';
  const primaryMasterKey = Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef', 'utf8');
  const wrongMasterKey = Buffer.from('fedcba9876543210fedcba9876543210fedcba9876543210', 'utf8');

  before(() => {
    temporaryRootDirectory = fileSystem.mkdtempSync(
      path.join(operatingSystem.tmpdir(), 'proton-backup-crypto-storage-'),
    );
  });

  after(() => {
    fileSystem.rmSync(temporaryRootDirectory, { recursive: true, force: true });
  });

  it('validates encryption key material, trims a single trailing newline, and rejects short keys', () => {
    const validKeyText = `${'k'.repeat(MINIMUM_ENCRYPTION_KEY_BYTE_LENGTH)}\n`;
    const validatedBuffer = validateEncryptionKeyMaterial(validKeyText, '/secrets/test.key');
    assert.equal(validatedBuffer.length, MINIMUM_ENCRYPTION_KEY_BYTE_LENGTH);
    assert.equal(validatedBuffer.toString('utf8'), 'k'.repeat(MINIMUM_ENCRYPTION_KEY_BYTE_LENGTH));

    assert.throws(
      () => validateEncryptionKeyMaterial('too-short-secret\n', '/secrets/short.key'),
      /too short/,
    );
  });

  it('encrypts and decrypts state and session payloads with unique salts/IVs and 0600 permissions', async () => {
    const stateFilePath = path.join(temporaryRootDirectory, 'nested', 'state.json');
    const encryptionOptions: StorageEncryptionOptions = {
      encryptionKey: primaryMasterKey,
      allowPlaintext: false,
    };

    const samplePayload = {
      schemaVersion: 1,
      secretToken: 'sensitive-refresh-token-value',
      sensitivePath: '/Private/TaxReturns/2026.pdf',
    };

    await writeProtectedJsonFile({
      filePath: stateFilePath,
      purpose: 'state',
      payload: samplePayload,
      encryptionOptions,
    });

    const fileMode = fileSystem.statSync(stateFilePath).mode & 0o777;
    assert.equal(fileMode, 0o600);

    const rawFileText = fileSystem.readFileSync(stateFilePath, 'utf8');
    assert.equal(rawFileText.includes('sensitive-refresh-token-value'), false);
    assert.equal(rawFileText.includes('TaxReturns'), false);

    const parsedEnvelope = JSON.parse(rawFileText) as Record<string, unknown>;
    assert.equal(parsedEnvelope.encryptedFormatVersion, 1);
    assert.equal(parsedEnvelope.algorithm, 'aes-256-gcm');
    assert.equal(parsedEnvelope.keyDerivationFunction, 'hkdf-sha256');
    assert.equal(parsedEnvelope.purpose, 'state');

    const secondEnvelope = encryptJsonPayload(samplePayload, 'state', primaryMasterKey);
    assert.notEqual(secondEnvelope.saltBase64, parsedEnvelope.saltBase64);
    assert.notEqual(secondEnvelope.initializationVectorBase64, parsedEnvelope.initializationVectorBase64);

    const decryptedPayload = await readProtectedJsonFile({
      filePath: stateFilePath,
      purpose: 'state',
      encryptionOptions,
    });
    assert.deepEqual(decryptedPayload, samplePayload);
  });

  it('enforces domain separation between session and state envelopes via HKDF and AAD', () => {
    const sessionEnvelope = encryptJsonPayload(
      { sessionUid: 'uid-1' },
      'session',
      primaryMasterKey,
    ) as unknown as Record<string, unknown>;

    assert.throws(
      () => decryptJsonPayload(sessionEnvelope, 'state', primaryMasterKey),
      /purpose mismatch/,
    );

    const mutatedPurposeEnvelope: Record<string, unknown> = {
      ...sessionEnvelope,
      purpose: 'state',
    };
    assert.throws(
      () => decryptJsonPayload(mutatedPurposeEnvelope, 'state', primaryMasterKey),
      /invalid encryption key or tampered ciphertext/,
    );
  });

  it('fails loudly on wrong keys, tampered ciphertexts, missing keys, and plaintext downgrade attempts', async () => {
    const encryptedFilePath = path.join(temporaryRootDirectory, 'encrypted-session.json');
    await writeProtectedJsonFile({
      filePath: encryptedFilePath,
      purpose: 'session',
      payload: { token: 'abc' },
      encryptionOptions: { encryptionKey: primaryMasterKey },
    });

    await assert.rejects(
      () =>
        readProtectedJsonFile({
          filePath: encryptedFilePath,
          purpose: 'session',
          encryptionOptions: { encryptionKey: wrongMasterKey },
        }),
      /invalid encryption key or tampered ciphertext/,
    );

    await assert.rejects(
      () =>
        readProtectedJsonFile({
          filePath: encryptedFilePath,
          purpose: 'session',
          encryptionOptions: { allowPlaintext: true },
        }),
      /is encrypted, but no encryption key was provided/,
    );

    const tamperedEnvelope = JSON.parse(fileSystem.readFileSync(encryptedFilePath, 'utf8')) as Record<
      string,
      string
    >;
    const originalCiphertext = Buffer.from(tamperedEnvelope.ciphertextBase64 ?? '', 'base64');
    originalCiphertext[0] = (originalCiphertext[0] ?? 0) ^ 0xff;
    tamperedEnvelope.ciphertextBase64 = originalCiphertext.toString('base64');

    const tamperedFilePath = path.join(temporaryRootDirectory, 'tampered-session.json');
    fileSystem.writeFileSync(tamperedFilePath, JSON.stringify(tamperedEnvelope), 'utf8');

    await assert.rejects(
      () =>
        readProtectedJsonFile({
          filePath: tamperedFilePath,
          purpose: 'session',
          encryptionOptions: { encryptionKey: primaryMasterKey },
        }),
      /invalid encryption key or tampered ciphertext/,
    );

    const plaintextFilePath = path.join(temporaryRootDirectory, 'plaintext-state.json');
    fileSystem.writeFileSync(plaintextFilePath, JSON.stringify({ schemaVersion: 1 }), 'utf8');

    await assert.rejects(
      () =>
        readProtectedJsonFile({
          filePath: plaintextFilePath,
          purpose: 'state',
          encryptionOptions: { encryptionKey: primaryMasterKey },
        }),
      /Refusing to load unencrypted plaintext state file/,
    );
  });

  it('refuses plaintext reads and writes unless allowPlaintext is explicitly enabled', async () => {
    const disallowedFilePath = path.join(temporaryRootDirectory, 'disallowed-plaintext.json');

    await assert.rejects(
      () =>
        writeProtectedJsonFile({
          filePath: disallowedFilePath,
          purpose: 'state',
          payload: { ok: true },
          encryptionOptions: {},
        }),
      /Refusing to write plaintext state file/,
    );

    await writeProtectedJsonFile({
      filePath: disallowedFilePath,
      purpose: 'state',
      payload: { ok: true },
      encryptionOptions: { allowPlaintext: true },
    });

    await assert.rejects(
      () =>
        readProtectedJsonFile({
          filePath: disallowedFilePath,
          purpose: 'state',
          encryptionOptions: {},
        }),
      /Refusing to load plaintext state file/,
    );

    const loaded = await readProtectedJsonFile({
      filePath: disallowedFilePath,
      purpose: 'state',
      encryptionOptions: { allowPlaintext: true },
    });
    assert.deepEqual(loaded, { ok: true });
  });

  it('round-trips PersistedSessionData cleanly through saveSessionData and loadSessionData', async () => {
    const sessionFilePath = path.join(temporaryRootDirectory, 'session-roundtrip.json');
    const sessionData: PersistedSessionData = {
      schemaVersion: 1,
      sessionUid: 'session-uid-1',
      accessToken: 'access-token-secret',
      refreshToken: 'refresh-token-secret',
      userId: 'user-1',
      email: 'user@proton.me',
      keyPassphrasesByKeyId: { 'key-1': 'derived-passphrase-secret' },
      primaryKeyPassphrase: 'derived-passphrase-secret',
      savedAtIso: '2026-11-22T12:00:00.000Z',
    };

    const encryptionOptions: StorageEncryptionOptions = {
      encryptionKey: primaryMasterKey,
    };

    await saveSessionData(sessionFilePath, sessionData, encryptionOptions);

    const diskContents = fileSystem.readFileSync(sessionFilePath, 'utf8');
    assert.equal(diskContents.includes('access-token-secret'), false);
    assert.equal(diskContents.includes('derived-passphrase-secret'), false);

    const loadedSession = await loadSessionData(sessionFilePath, encryptionOptions);
    assert.deepEqual(loadedSession, sessionData);
  });
});
