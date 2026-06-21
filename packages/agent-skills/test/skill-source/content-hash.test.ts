/* eslint-disable security/detect-non-literal-fs-filename -- tmpdir paths constructed in test setup */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hashDirectory } from '../../src/skill-source/content-hash.js';

describe('hashDirectory', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-hash-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns a 64-char lowercase hex SHA-256', async () => {
    writeFileSync(safePath.join(dir, 'a.txt'), 'hello');
    const hash = await hashDirectory(dir);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is identical for identical content regardless of file creation order', async () => {
    writeFileSync(safePath.join(dir, 'a.txt'), 'A');
    writeFileSync(safePath.join(dir, 'b.txt'), 'B');
    const first = await hashDirectory(dir);

    const dir2 = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-hash-'));
    writeFileSync(safePath.join(dir2, 'b.txt'), 'B');
    writeFileSync(safePath.join(dir2, 'a.txt'), 'A');
    const second = await hashDirectory(dir2);
    rmSync(dir2, { recursive: true, force: true });

    expect(first).toBe(second);
  });

  it('changes when file content changes', async () => {
    writeFileSync(safePath.join(dir, 'a.txt'), 'A');
    const before = await hashDirectory(dir);
    writeFileSync(safePath.join(dir, 'a.txt'), 'A2');
    const after = await hashDirectory(dir);
    expect(before).not.toBe(after);
  });

  it('changes when a file is added in a nested directory', async () => {
    writeFileSync(safePath.join(dir, 'a.txt'), 'A');
    const before = await hashDirectory(dir);
    mkdirSyncReal(safePath.join(dir, 'sub'));
    writeFileSync(safePath.join(dir, 'sub', 'c.txt'), 'C');
    const after = await hashDirectory(dir);
    expect(before).not.toBe(after);
  });
});
