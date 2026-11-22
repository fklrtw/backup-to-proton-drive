import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decodeBase32Secret, generateTotpCode } from '../src/proton/totp.ts';

describe('TOTP generator', () => {
  // Official RFC 6238 SHA-1 test secret ("12345678901234567890" encoded in Base32).
  const rfcTestSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

  it('decodes Base32 secrets with spaces, hyphens, lowercase, and padding', () => {
    const cleanDecoded = decodeBase32Secret(rfcTestSecret);
    const messyDecoded = decodeBase32Secret(' gezd-gnbv gy3t-qojq gezd gnbv gy3t qojq==== ');
    assert.deepEqual(cleanDecoded, Buffer.from('12345678901234567890', 'ascii'));
    assert.deepEqual(messyDecoded, cleanDecoded);
  });

  it('rejects empty or invalid Base32 secrets', () => {
    assert.throws(() => decodeBase32Secret('   '), /must not be empty/);
    assert.throws(() => decodeBase32Secret('INVALID!SECRET'), /Invalid Base32 character/);
  });

  it('matches RFC 6238 SHA-1 test vectors accurately', () => {
    assert.equal(generateTotpCode(rfcTestSecret, 59_000, 30, 8), '94287082');
    assert.equal(generateTotpCode(rfcTestSecret, 59_000, 30, 6), '287082');

    assert.equal(generateTotpCode(rfcTestSecret, 1_111_111_109_000, 30, 8), '07081804');
    assert.equal(generateTotpCode(rfcTestSecret, 1_111_111_109_000, 30, 6), '081804');

    assert.equal(generateTotpCode(rfcTestSecret, 1_234_567_890_000, 30, 8), '89005924');
    assert.equal(generateTotpCode(rfcTestSecret, 1_234_567_890_000, 30, 6), '005924');

    assert.equal(generateTotpCode(rfcTestSecret, 2_000_000_000_000, 30, 8), '69279037');
    assert.equal(generateTotpCode(rfcTestSecret, 2_000_000_000_000, 30, 6), '279037');
  });
});
