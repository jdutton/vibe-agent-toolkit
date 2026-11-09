/**
 * `runGitBytes` against a real object store: what a commit holds comes back as the bytes git
 * wrote. The unit suite's fixtures are valid UTF-8, which a lossy transport also round-trips; only a
 * blob that is NOT UTF-8 tells the byte-exact transport from one that decodes and re-encodes.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runGit, runGitBytes } from '../../src/git-run.js';
import { normalizedTmpdir, safePath } from '../../src/path-utils.js';

describe('runGitBytes reads the object store byte for byte', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-git-bytes-'));
    expect(runGit(['init', '-q'], { cwd: dir }).ok).toBe(true);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns a blob that is not UTF-8 as its bytes, where a text read substitutes U+FFFD', () => {
    const bytes = Buffer.from([0x61, 0xff, 0xfe, 0x80, 0x0a]);
    writeFileSync(safePath.join(dir, 'blob'), bytes);
    const oid = runGit(['hash-object', '-w', 'blob'], { cwd: dir }).stdout;

    const result = runGitBytes(['cat-file', 'blob', oid], { cwd: dir });

    expect(result.ok).toBe(true);
    expect(result.stdout).toEqual(bytes);
  });
});
