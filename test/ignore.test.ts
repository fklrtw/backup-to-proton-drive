import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compileExcludeMatcher } from '../src/ignore.ts';

describe('compileExcludeMatcher', () => {
  it('ignores blank lines and comment entries', () => {
    const matcher = compileExcludeMatcher(['', '   ', '# comment line', '*.tmp']);
    assert.equal(matcher.isExcluded('notes.txt', false), false);
    assert.equal(matcher.isExcluded('draft.tmp', false), true);
  });

  it('matches filename patterns across any directory depth when unanchored', () => {
    const matcher = compileExcludeMatcher(['.DS_Store', '*.log', 'file-?.txt']);

    assert.equal(matcher.isExcluded('.DS_Store', false), true);
    assert.equal(matcher.isExcluded('nested/deep/.DS_Store', false), true);
    assert.equal(matcher.isExcluded('logs/app.log', false), true);
    assert.equal(matcher.isExcluded('file-1.txt', false), true);
    assert.equal(matcher.isExcluded('file-10.txt', false), false);
    assert.equal(matcher.isExcluded('nested/keep.txt', false), false);
  });

  it('respects trailing slashes for directory-only rules and prunes children', () => {
    const matcher = compileExcludeMatcher(['node_modules/', 'build/output/']);

    assert.equal(matcher.isExcluded('node_modules', true), true);
    assert.equal(matcher.isExcluded('node_modules', false), false);
    assert.equal(matcher.isExcluded('packages/app/node_modules', true), true);
    assert.equal(matcher.isExcluded('packages/app/node_modules/index.js', false), true);

    assert.equal(matcher.isExcluded('build/output', true), true);
    assert.equal(matcher.isExcluded('build/output', false), false);
    assert.equal(matcher.isExcluded('build/output/bundle.js', false), true);
    assert.equal(matcher.isExcluded('src/build/output', true), false);
  });

  it('matches anchored patterns with globstars cleanly', () => {
    const matcher = compileExcludeMatcher(['/root-only.txt', 'data/**/cache/*.bin']);

    assert.equal(matcher.isExcluded('root-only.txt', false), true);
    assert.equal(matcher.isExcluded('sub/root-only.txt', false), false);

    assert.equal(matcher.isExcluded('data/cache/items.bin', false), true);
    assert.equal(matcher.isExcluded('data/year/2026/cache/items.bin', false), true);
    assert.equal(matcher.isExcluded('data/year/cache/nested/items.bin', false), false);
  });
});
