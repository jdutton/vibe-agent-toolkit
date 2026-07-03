/* eslint-disable security/detect-non-literal-fs-filename -- Test code using temp directories */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { fileContentHash, safePath } from '../../src/index.js';
import { setupSyncTempDirSuite } from '../../src/test-helpers.js';

describe('fileContentHash', () => {
  const suite = setupSyncTempDirSuite('file-hash');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(() => {
    suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('same bytes in two files produce the same hash', () => {
    const bytes = Buffer.from('hello world');
    const fileA = safePath.join(tempDir, 'a.txt');
    const fileB = safePath.join(tempDir, 'b.txt');
    writeFileSync(fileA, bytes);
    writeFileSync(fileB, bytes);

    expect(fileContentHash(fileA)).toBe(fileContentHash(fileB));
  });

  it('different content produces a different hash', () => {
    const fileA = safePath.join(tempDir, 'a.txt');
    const fileB = safePath.join(tempDir, 'b.txt');
    writeFileSync(fileA, 'foo');
    writeFileSync(fileB, 'bar');

    expect(fileContentHash(fileA)).not.toBe(fileContentHash(fileB));
  });

  it('hash matches an independently-computed sha256 hex digest', () => {
    const content = 'the quick brown fox';
    const filePath = safePath.join(tempDir, 'fox.txt');
    const bytes = Buffer.from(content, 'utf8');
    writeFileSync(filePath, bytes);

    const expected = createHash('sha256').update(bytes).digest('hex');
    expect(fileContentHash(filePath)).toBe(expected);
  });

  it('returns a lowercase hex string of length 64', () => {
    const filePath = safePath.join(tempDir, 'len.txt');
    writeFileSync(filePath, 'some content');

    const hash = fileContentHash(filePath);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[\da-f]+$/);
  });
});
