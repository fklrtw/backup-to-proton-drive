import * as nodeCrypto from 'node:crypto';
import * as fileSystem from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Minimum required key material length in bytes for `DATA_ENCRYPTION_KEY_FILE`.
 * Accepts any 32+ byte secret (for example `openssl rand -base64 32`, which yields
 * 44 ASCII bytes) and feeds it through HKDF-SHA256 with a per-write 32-byte random salt.
 */
export const MINIMUM_ENCRYPTION_KEY_BYTE_LENGTH = 32;

/**
 * Logical storage file classification used both for HKDF domain separation
 * and AES-256-GCM Additional Authenticated Data (AAD) binding.
 */
export type StorageFilePurpose = 'session' | 'state';

/**
 * Controls how persistent JSON files (`session.json` and `state.json`) are protected at rest.
 */
export interface StorageEncryptionOptions {
  /** Master key bytes loaded from `DATA_ENCRYPTION_KEY_FILE` or `--encryption-key-file`. */
  encryptionKey?: Buffer | undefined;
  /** Explicit opt-out permitting plaintext `0600` JSON when no encryption key is supplied. */
  allowPlaintext?: boolean | undefined;
}

/**
 * Versioned authenticated-encryption envelope written to disk when at-rest encryption
 * is active for `session.json` or `state.json`.
 */
export interface EncryptedStorageEnvelopeV1 {
  /** Schema version for forward format evolution. */
  encryptedFormatVersion: 1;
  /** Symmetric AEAD cipher algorithm. */
  algorithm: 'aes-256-gcm';
  /** Key derivation primitive applied to the master encryption key and random salt. */
  keyDerivationFunction: 'hkdf-sha256';
  /** Logical file classification bound into HKDF `info` and GCM AAD to prevent file swapping. */
  purpose: StorageFilePurpose;
  /** Base64-encoded 32-byte per-write HKDF salt. */
  saltBase64: string;
  /** Base64-encoded 12-byte AES-GCM nonce/initialization vector. */
  initializationVectorBase64: string;
  /** Base64-encoded 16-byte AES-GCM authentication tag. */
  authenticationTagBase64: string;
  /** Base64-encoded ciphertext payload (JSON UTF-8 bytes). */
  ciphertextBase64: string;
}

const SALT_BYTE_LENGTH = 32;
const INITIALIZATION_VECTOR_BYTE_LENGTH = 12;
const AUTHENTICATION_TAG_BYTE_LENGTH = 16;
const AES_256_KEY_BYTE_LENGTH = 32;

/**
 * Builds the HKDF `info` and AES-GCM Additional Authenticated Data (AAD) string
 * binding an encrypted payload to a specific file purpose (`session` vs. `state`).
 *
 * @param purpose - Target protected file classification.
 * @returns Domain-separated ASCII context label.
 */
function buildDomainSeparationContext(purpose: StorageFilePurpose): string {
  return `backup-to-proton-drive:${purpose}:v1`;
}

/**
 * Normalizes and validates raw key material read from a secret file, trimming a single
 * trailing newline and verifying that at least {@link MINIMUM_ENCRYPTION_KEY_BYTE_LENGTH}
 * bytes are present.
 *
 * @param rawKeyText - UTF-8 text read from `DATA_ENCRYPTION_KEY_FILE`.
 * @param sourceDescription - Descriptive source path or flag label for error messages.
 * @returns Validated master key byte buffer.
 */
export function validateEncryptionKeyMaterial(rawKeyText: string, sourceDescription: string): Buffer {
  const normalizedKeyText = rawKeyText.replace(/\r?\n$/, '');
  const keyMaterialBuffer = Buffer.from(normalizedKeyText, 'utf8');

  if (keyMaterialBuffer.length < MINIMUM_ENCRYPTION_KEY_BYTE_LENGTH) {
    throw new Error(
      `Encryption key in ${sourceDescription} is too short (${keyMaterialBuffer.length} bytes; minimum ${MINIMUM_ENCRYPTION_KEY_BYTE_LENGTH} bytes required). Generate one with: openssl rand -base64 32`,
    );
  }

  return keyMaterialBuffer;
}

/**
 * Derives a unique 256-bit AES encryption key using HKDF-SHA256 from the supplied
 * master key, per-write random salt, and file-purpose context string.
 *
 * @param masterEncryptionKey - Master key buffer (>= 32 bytes).
 * @param salt - 32-byte random salt.
 * @param domainSeparationContext - Context string distinguishing `session` vs. `state`.
 * @returns 32-byte symmetric AES-256 key buffer.
 */
function deriveSymmetricKey(
  masterEncryptionKey: Buffer,
  salt: Buffer,
  domainSeparationContext: string,
): Buffer {
  const derivedKeyArrayBuffer = nodeCrypto.hkdfSync(
    'sha256',
    masterEncryptionKey,
    salt,
    domainSeparationContext,
    AES_256_KEY_BYTE_LENGTH,
  );
  return Buffer.from(derivedKeyArrayBuffer);
}

/**
 * Encrypts an arbitrary JSON-serializable value into an authenticated
 * {@link EncryptedStorageEnvelopeV1} using HKDF-SHA256 and AES-256-GCM.
 *
 * @param payload - Plaintext JavaScript value to serialize as JSON and encrypt.
 * @param purpose - Classification (`session` or `state`) bound into key derivation and AAD.
 * @param masterEncryptionKey - Validated master encryption key (>= 32 bytes).
 * @returns Encrypted storage envelope ready to write as JSON.
 */
export function encryptJsonPayload(
  payload: unknown,
  purpose: StorageFilePurpose,
  masterEncryptionKey: Buffer,
): EncryptedStorageEnvelopeV1 {
  if (masterEncryptionKey.length < MINIMUM_ENCRYPTION_KEY_BYTE_LENGTH) {
    throw new Error(
      `Master encryption key must be at least ${MINIMUM_ENCRYPTION_KEY_BYTE_LENGTH} bytes.`,
    );
  }

  const salt = nodeCrypto.randomBytes(SALT_BYTE_LENGTH);
  const initializationVector = nodeCrypto.randomBytes(INITIALIZATION_VECTOR_BYTE_LENGTH);
  const domainSeparationContext = buildDomainSeparationContext(purpose);
  const derivedEncryptionKey = deriveSymmetricKey(masterEncryptionKey, salt, domainSeparationContext);
  const additionalAuthenticatedData = Buffer.from(domainSeparationContext, 'utf8');

  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', derivedEncryptionKey, initializationVector, {
    authTagLength: AUTHENTICATION_TAG_BYTE_LENGTH,
  });
  cipher.setAAD(additionalAuthenticatedData);

  const plaintextBuffer = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertextBuffer = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
  const authenticationTag = cipher.getAuthTag();

  // Scrub ephemeral derived symmetric key bytes once cipher encryption completes.
  derivedEncryptionKey.fill(0);

  return {
    encryptedFormatVersion: 1,
    algorithm: 'aes-256-gcm',
    keyDerivationFunction: 'hkdf-sha256',
    purpose,
    saltBase64: salt.toString('base64'),
    initializationVectorBase64: initializationVector.toString('base64'),
    authenticationTagBase64: authenticationTag.toString('base64'),
    ciphertextBase64: ciphertextBuffer.toString('base64'),
  };
}

/**
 * Type guard checking whether a parsed JSON object uses the encrypted storage envelope structure.
 *
 * @param candidate - Unknown parsed JSON value.
 * @returns `true` if `candidate` appears to be an encrypted envelope object.
 */
export function isEncryptedStorageEnvelope(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate) && 'encryptedFormatVersion' in candidate;
}

/**
 * Authenticates and decrypts an {@link EncryptedStorageEnvelopeV1} back into its original
 * parsed JSON value, verifying format fields, purpose binding, and GCM authentication tag.
 *
 * @param envelopeCandidate - Parsed JSON object representing an encrypted envelope.
 * @param expectedPurpose - Expected logical file classification (`session` or `state`).
 * @param masterEncryptionKey - Validated master encryption key (>= 32 bytes).
 * @returns Decrypted and parsed JSON payload.
 */
export function decryptJsonPayload(
  envelopeCandidate: Record<string, unknown>,
  expectedPurpose: StorageFilePurpose,
  masterEncryptionKey: Buffer,
): unknown {
  if (
    envelopeCandidate.encryptedFormatVersion !== 1 ||
    envelopeCandidate.algorithm !== 'aes-256-gcm' ||
    envelopeCandidate.keyDerivationFunction !== 'hkdf-sha256'
  ) {
    throw new Error(
      `Unsupported encrypted ${expectedPurpose} file envelope format (version=${String(envelopeCandidate.encryptedFormatVersion)}, algorithm=${String(envelopeCandidate.algorithm)}).`,
    );
  }

  if (envelopeCandidate.purpose !== expectedPurpose) {
    throw new Error(
      `Encrypted storage purpose mismatch: expected "${expectedPurpose}", found "${String(envelopeCandidate.purpose)}".`,
    );
  }

  if (
    typeof envelopeCandidate.saltBase64 !== 'string' ||
    typeof envelopeCandidate.initializationVectorBase64 !== 'string' ||
    typeof envelopeCandidate.authenticationTagBase64 !== 'string' ||
    typeof envelopeCandidate.ciphertextBase64 !== 'string'
  ) {
    throw new Error(`Malformed encrypted ${expectedPurpose} envelope: missing required base64 fields.`);
  }

  const salt = Buffer.from(envelopeCandidate.saltBase64, 'base64');
  const initializationVector = Buffer.from(envelopeCandidate.initializationVectorBase64, 'base64');
  const authenticationTag = Buffer.from(envelopeCandidate.authenticationTagBase64, 'base64');
  const ciphertextBuffer = Buffer.from(envelopeCandidate.ciphertextBase64, 'base64');

  if (
    salt.length !== SALT_BYTE_LENGTH ||
    initializationVector.length !== INITIALIZATION_VECTOR_BYTE_LENGTH ||
    authenticationTag.length !== AUTHENTICATION_TAG_BYTE_LENGTH
  ) {
    throw new Error(`Malformed encrypted ${expectedPurpose} envelope: invalid cryptographic parameter length.`);
  }

  const domainSeparationContext = buildDomainSeparationContext(expectedPurpose);
  const derivedEncryptionKey = deriveSymmetricKey(masterEncryptionKey, salt, domainSeparationContext);
  const additionalAuthenticatedData = Buffer.from(domainSeparationContext, 'utf8');

  let decryptedJsonText: string;
  try {
    const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', derivedEncryptionKey, initializationVector, {
      authTagLength: AUTHENTICATION_TAG_BYTE_LENGTH,
    });
    decipher.setAAD(additionalAuthenticatedData);
    decipher.setAuthTag(authenticationTag);

    const decryptedBuffer = Buffer.concat([decipher.update(ciphertextBuffer), decipher.final()]);
    decryptedJsonText = decryptedBuffer.toString('utf8');
  } catch {
    throw new Error(
      `Failed to decrypt ${expectedPurpose} file: invalid encryption key or tampered ciphertext.`,
    );
  } finally {
    derivedEncryptionKey.fill(0);
  }

  try {
    return JSON.parse(decryptedJsonText) as unknown;
  } catch {
    throw new Error(`Decrypted ${expectedPurpose} payload is not valid JSON.`);
  }
}

/**
 * Atomically serializes and writes a protected JSON file (`session.json` or `state.json`)
 * inside a `0700` parent directory with `0600` file permissions. Refuses plaintext writes
 * unless `allowPlaintext: true` is explicitly specified when no encryption key is configured.
 *
 * @param options - Destination file path, classification, payload, and encryption policy.
 */
export async function writeProtectedJsonFile(options: {
  filePath: string;
  purpose: StorageFilePurpose;
  payload: unknown;
  encryptionOptions: StorageEncryptionOptions;
}): Promise<void> {
  const { filePath, purpose, payload, encryptionOptions } = options;

  let serializedContent: string;
  if (encryptionOptions.encryptionKey) {
    const encryptedEnvelope = encryptJsonPayload(payload, purpose, encryptionOptions.encryptionKey);
    serializedContent = JSON.stringify(encryptedEnvelope, null, 2);
  } else if (encryptionOptions.allowPlaintext === true) {
    serializedContent = JSON.stringify(payload, null, 2);
  } else {
    throw new Error(
      `Refusing to write plaintext ${purpose} file at ${filePath}. Set DATA_ENCRYPTION_KEY_FILE (or --encryption-key-file) or explicitly opt out with ALLOW_PLAINTEXT_STATE=true (--allow-plaintext-state).`,
    );
  }

  const parentDirectory = path.dirname(filePath);
  await fileSystem.mkdir(parentDirectory, { recursive: true, mode: 0o700 });

  const temporaryFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fileSystem.writeFile(temporaryFilePath, serializedContent, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fileSystem.chmod(temporaryFilePath, 0o600);
  await fileSystem.rename(temporaryFilePath, filePath);
}

/**
 * Reads and verifies a protected JSON file (`session.json` or `state.json`).
 * Returns `null` solely when the file does not exist yet (or when malformed in explicit
 * plaintext mode). Always throws loudly on missing keys, wrong keys, tampered ciphertexts,
 * purpose mismatches, or unexpected plaintext files while encryption is enabled.
 *
 * @param options - Source file path, expected classification, and encryption policy.
 * @returns Parsed JSON payload, or `null` when absent.
 */
export async function readProtectedJsonFile(options: {
  filePath: string;
  purpose: StorageFilePurpose;
  encryptionOptions: StorageEncryptionOptions;
}): Promise<unknown | null> {
  const { filePath, purpose, encryptionOptions } = options;

  let rawContent: string;
  try {
    rawContent = await fileSystem.readFile(filePath, 'utf8');
  } catch (readError: unknown) {
    const fileSystemError = readError as NodeJS.ErrnoException;
    if (fileSystemError?.code === 'ENOENT') {
      return null;
    }
    throw readError;
  }

  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(rawContent) as unknown;
  } catch {
    if (encryptionOptions.encryptionKey) {
      throw new Error(`Stored ${purpose} file at ${filePath} is corrupted and cannot be parsed.`);
    }
    return null;
  }

  if (isEncryptedStorageEnvelope(parsedPayload)) {
    if (!encryptionOptions.encryptionKey) {
      throw new Error(
        `Stored ${purpose} file at ${filePath} is encrypted, but no encryption key was provided. Set DATA_ENCRYPTION_KEY_FILE or pass --encryption-key-file.`,
      );
    }

    try {
      return decryptJsonPayload(parsedPayload, purpose, encryptionOptions.encryptionKey);
    } catch (decryptionError: unknown) {
      const reason =
        decryptionError instanceof Error ? decryptionError.message : String(decryptionError);
      throw new Error(`${reason} (${filePath})`);
    }
  }

  if (encryptionOptions.encryptionKey) {
    throw new Error(
      `Refusing to load unencrypted plaintext ${purpose} file at ${filePath} while encryption is enabled. Remove the plaintext file and re-authenticate/resync, or pass --allow-plaintext-state only if plaintext storage is intentional.`,
    );
  }

  if (encryptionOptions.allowPlaintext !== true) {
    throw new Error(
      `Refusing to load plaintext ${purpose} file at ${filePath} without an encryption key. Set DATA_ENCRYPTION_KEY_FILE (or --encryption-key-file) or pass --allow-plaintext-state.`,
    );
  }

  return parsedPayload;
}
