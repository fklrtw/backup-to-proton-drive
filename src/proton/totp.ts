import * as crypto from 'node:crypto';

/**
 * RFC 4648 Base32 alphabet used by standard TOTP authenticator secrets.
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Decodes a Base32-encoded secret string into raw key bytes.
 * Strips whitespace, hyphens, and optional `=` padding, and accepts lowercase input.
 *
 * @param base32Secret - Base32-encoded shared TOTP secret.
 * @returns Raw secret bytes as a Node.js `Buffer`.
 */
export function decodeBase32Secret(base32Secret: string): Buffer {
  const sanitized = base32Secret.toUpperCase().replace(/[\s-]+/g, '').replace(/=+$/g, '');
  if (sanitized.length === 0) {
    throw new Error('TOTP secret must not be empty.');
  }

  let bitAccumulator = 0;
  let accumulatedBitCount = 0;
  const decodedBytes: number[] = [];

  for (let characterIndex = 0; characterIndex < sanitized.length; characterIndex++) {
    const character = sanitized[characterIndex] ?? '';
    const alphabetIndex = BASE32_ALPHABET.indexOf(character);
    if (alphabetIndex === -1) {
      throw new Error(`Invalid Base32 character "${character}" in TOTP secret.`);
    }

    bitAccumulator = (bitAccumulator << 5) | alphabetIndex;
    accumulatedBitCount += 5;

    if (accumulatedBitCount >= 8) {
      accumulatedBitCount -= 8;
      decodedBytes.push((bitAccumulator >>> accumulatedBitCount) & 0xff);
    }
  }

  return Buffer.from(decodedBytes);
}

/**
 * Generates an RFC 6238 / RFC 4226 HMAC-SHA1 Time-based One-Time Password (TOTP) code.
 *
 * @param base32Secret - Base32-encoded TOTP secret configured in Proton 2FA settings.
 * @param timestampMilliseconds - Current UTC timestamp in milliseconds (defaults to `Date.now()`).
 * @param periodSeconds - Validity window step duration in seconds (defaults to `30`).
 * @param digitCount - Number of output digits (defaults to `6`).
 * @returns Zero-padded numeric TOTP code string.
 */
export function generateTotpCode(
  base32Secret: string,
  timestampMilliseconds = Date.now(),
  periodSeconds = 30,
  digitCount = 6,
): string {
  if (periodSeconds <= 0 || !Number.isFinite(periodSeconds)) {
    throw new Error(`Invalid TOTP period: ${periodSeconds}`);
  }
  if (digitCount < 1 || digitCount > 10) {
    throw new Error(`Invalid TOTP digit count: ${digitCount}`);
  }

  const secretBuffer = decodeBase32Secret(base32Secret);
  const timeStepCounter = Math.floor(timestampMilliseconds / 1000 / periodSeconds);

  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(timeStepCounter), 0);

  const hmacDigest = crypto.createHmac('sha1', secretBuffer).update(counterBuffer).digest();
  const lastByte = hmacDigest[hmacDigest.length - 1] ?? 0;
  const dynamicOffset = lastByte & 0x0f;

  const firstSliceByte = hmacDigest[dynamicOffset] ?? 0;
  const secondSliceByte = hmacDigest[dynamicOffset + 1] ?? 0;
  const thirdSliceByte = hmacDigest[dynamicOffset + 2] ?? 0;
  const fourthSliceByte = hmacDigest[dynamicOffset + 3] ?? 0;

  const truncatedInteger =
    ((firstSliceByte & 0x7f) << 24) |
    ((secondSliceByte & 0xff) << 16) |
    ((thirdSliceByte & 0xff) << 8) |
    (fourthSliceByte & 0xff);

  const modulus = 10 ** digitCount;
  const numericCode = truncatedInteger % modulus;
  return String(numericCode).padStart(digitCount, '0');
}
