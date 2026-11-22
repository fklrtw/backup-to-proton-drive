import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatBytes, formatProtonAppVersionHeader, inferMediaType } from '../src/format.ts';

describe('formatBytes', () => {
  it('formats zero, small fractions, and negative values safely', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(-0), '0 B');
    assert.equal(formatBytes(Number.NaN), '0 B');
    assert.equal(formatBytes(Number.POSITIVE_INFINITY), '0 B');
    assert.equal(formatBytes(0.5), '0.5 B');
    assert.equal(formatBytes(-1024), '-1 KB');
    assert.equal(formatBytes(-1536, 1), '-1.5 KB');
  });

  it('formats binary byte multiples and clamps units at EB', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1024), '1 KB');
    assert.equal(formatBytes(1024 * 1024 * 1.5), '1.5 MB');
    assert.equal(formatBytes(1024 ** 4), '1 TB');
    assert.equal(formatBytes(1024 ** 5), '1 PB');
    assert.equal(formatBytes(1024 ** 6), '1 EB');
    assert.equal(formatBytes(1024 ** 7), '1024 EB');
  });

  it('handles negative and custom decimal precision cleanly', () => {
    assert.equal(formatBytes(1550, -3), '2 KB');
    assert.equal(formatBytes(1536, 3), '1.5 KB');
    assert.equal(formatBytes(1234567, 2), '1.18 MB');
  });
});

describe('inferMediaType', () => {
  it('maps known extensions case-insensitively and falls back to octet-stream', () => {
    assert.equal(inferMediaType('/backups/document.PDF'), 'application/pdf');
    assert.equal(inferMediaType('archive.tar.gz'), 'application/gzip');
    assert.equal(inferMediaType('config.yaml'), 'application/yaml');
    assert.equal(inferMediaType('image.jpg'), 'image/jpeg');
    assert.equal(inferMediaType('no-extension'), 'application/octet-stream');
    assert.equal(inferMediaType('blob.custombin'), 'application/octet-stream');
  });
});

describe('formatProtonAppVersionHeader', () => {
  it('formats external-drive header without extra hyphens in the product name section', () => {
    const headerValue = formatProtonAppVersionHeader('0.1.0');
    assert.equal(headerValue, 'external-drive-backuptoprotondrive@0.1.0');

    const [sectionPart, versionPart] = headerValue.split('@');
    assert.ok(sectionPart);
    assert.equal(versionPart, '0.1.0');
    assert.match(sectionPart, /^external-drive-[a-z0-9]+$/);
  });
});
