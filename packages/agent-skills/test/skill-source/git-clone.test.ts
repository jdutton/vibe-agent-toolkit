import { mkdtempSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

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
  it('clones a ref and returns ref + full 40-char commit + repo-root targetDir', () => {
    const tempdir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-gc-clone-'));
    const out = cloneGitSource(parseGitUrl(`${bareUrl}#main`), tempdir);
    expect(out.ref).toBe('main');
    // Full SHA (not truncated): the commit is the git cache key, so a short SHA
    // risks cross-repo collisions / silent stale-tree reuse (M3).
    expect(out.commit).toMatch(/^[0-9a-f]{40}$/);
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

  it('clones the default branch (HEAD) when no ref is given', () => {
    const tempdir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-gc-head-'));
    const out = cloneGitSource(parseGitUrl(bareUrl), tempdir);
    expect(out.ref).toBe('HEAD');
    expect(out.commit).toMatch(/^[0-9a-f]{40}$/);
    rmSync(tempdir, { recursive: true, force: true });
  });

  it('throws a "Reference not found" hint when the requested ref does not exist', () => {
    const tempdir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-gc-badref-'));
    expect(() => cloneGitSource(parseGitUrl(`${bareUrl}#no-such-branch`), tempdir)).toThrow(
      /Reference not found/i,
    );
    rmSync(tempdir, { recursive: true, force: true });
  });

  it('throws "Clone failed" when the repository URL is unreachable', () => {
    const tempdir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-gc-badurl-'));
    const bogusBare = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-gc-nope-'));
    const bogusUrl = pathToFileURL(safePath.join(bogusBare, 'does-not-exist')).href;
    expect(() => cloneGitSource(parseGitUrl(bogusUrl), tempdir)).toThrow(/Clone failed/i);
    rmSync(tempdir, { recursive: true, force: true });
    rmSync(bogusBare, { recursive: true, force: true });
  });

  it('throws "Subpath not found" when the ref exists but the subpath is absent', () => {
    const tempdir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-gc-nosub-'));
    expect(() => cloneGitSource(parseGitUrl(`${bareUrl}#main:plugins/missing`), tempdir)).toThrow(
      /Subpath not found in cloned repo/i,
    );
    rmSync(tempdir, { recursive: true, force: true });
  });
});
