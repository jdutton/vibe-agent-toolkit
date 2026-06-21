import { mkdtempSync, rmSync } from 'node:fs';

import { normalizedTmpdir, parseGitUrl, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cloneGitSource } from '../../src/skill-source/git-clone.js';

import { makeBareRepoWithSkill } from './test-helpers.js';

let bareUrl: string;
let fixtureCleanup: () => void;

beforeAll(() => {
  const fixture = makeBareRepoWithSkill({ skillSubdir: 'plugins/foo' });
  bareUrl = fixture.bareUrl;
  fixtureCleanup = fixture.cleanup;
});

afterAll(() => {
  fixtureCleanup();
});

describe('cloneGitSource', () => {
  it('clones a ref and returns ref + 8-char commit + repo-root targetDir', () => {
    const tempdir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-gc-clone-'));
    const out = cloneGitSource(parseGitUrl(`${bareUrl}#main`), tempdir);
    expect(out.ref).toBe('main');
    expect(out.commit).toMatch(/^[0-9a-f]{8}$/);
    expect(out.targetDir).toBe(tempdir);
    rmSync(tempdir, { recursive: true, force: true });
  });

  it('resolves a subpath inside the clone', () => {
    const tempdir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-gc-sub-'));
    const out = cloneGitSource(parseGitUrl(`${bareUrl}#main:plugins/foo`), tempdir);
    expect(out.targetDir).toBe(safePath.join(tempdir, 'plugins/foo'));
    rmSync(tempdir, { recursive: true, force: true });
  });

  it('rejects a subpath that escapes the clone', () => {
    const tempdir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-gc-esc-'));
    expect(() => cloneGitSource(parseGitUrl(`${bareUrl}#main:../../etc`), tempdir)).toThrow(
      /escapes the cloned repository/i,
    );
    rmSync(tempdir, { recursive: true, force: true });
  });
});
