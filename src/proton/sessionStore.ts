import * as fileSystem from 'node:fs/promises';

import {
  readProtectedJsonFile,
  type StorageEncryptionOptions,
  writeProtectedJsonFile,
} from '../storageEncryption.ts';
import type { PersistedSessionData } from '../types.ts';

/**
 * Loads a previously persisted Proton session file from disk (decrypting it with
 * `encryptionOptions.encryptionKey` when encrypted).
 * Returns `null` when the file is absent or fails plaintext schema validation;
 * throws loudly on missing keys, invalid keys, tampered ciphertexts, or downgrade attempts.
 *
 * @param sessionFilePath - Path to the session file.
 * @param encryptionOptions - At-rest encryption key and plaintext opt-out policy.
 * @returns Validated {@link PersistedSessionData} or `null`.
 */
export async function loadSessionData(
  sessionFilePath: string,
  encryptionOptions: StorageEncryptionOptions,
): Promise<PersistedSessionData | null> {
  const parsedPayload = await readProtectedJsonFile({
    filePath: sessionFilePath,
    purpose: 'session',
    encryptionOptions,
  });

  if (parsedPayload === null || typeof parsedPayload !== 'object' || Array.isArray(parsedPayload)) {
    return null;
  }

  const candidate = parsedPayload as Partial<PersistedSessionData>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.sessionUid !== 'string' ||
    candidate.sessionUid.length === 0 ||
    typeof candidate.accessToken !== 'string' ||
    candidate.accessToken.length === 0 ||
    typeof candidate.refreshToken !== 'string' ||
    candidate.refreshToken.length === 0 ||
    typeof candidate.userId !== 'string' ||
    typeof candidate.email !== 'string' ||
    typeof candidate.keyPassphrasesByKeyId !== 'object' ||
    candidate.keyPassphrasesByKeyId === null ||
    typeof candidate.primaryKeyPassphrase !== 'string'
  ) {
    return null;
  }

  return candidate as PersistedSessionData;
}

/**
 * Atomically persists Proton session tokens and salted key passphrases to disk with
 * restrictive `0600` file permissions inside a `0700` parent directory, encrypted with
 * AES-256-GCM by default.
 *
 * @param sessionFilePath - Destination path for the session file.
 * @param sessionData - Authenticated session data to store.
 * @param encryptionOptions - At-rest encryption key and plaintext opt-out policy.
 */
export async function saveSessionData(
  sessionFilePath: string,
  sessionData: PersistedSessionData,
  encryptionOptions: StorageEncryptionOptions,
): Promise<void> {
  await writeProtectedJsonFile({
    filePath: sessionFilePath,
    purpose: 'session',
    payload: sessionData,
    encryptionOptions,
  });
}

/**
 * Removes a persisted session file if it exists (ignoring missing-file errors).
 *
 * @param sessionFilePath - Path to the session file to delete.
 */
export async function deleteSessionData(sessionFilePath: string): Promise<void> {
  try {
    await fileSystem.unlink(sessionFilePath);
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code !== 'ENOENT') {
      throw error;
    }
  }
}
