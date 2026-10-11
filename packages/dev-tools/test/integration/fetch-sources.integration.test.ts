/**
 * Regression test for the moved-annotated-tag bug in refreshGitRef.
 *
 * Background: when a CorpusEntry sources its skill from a git tag and the
 * upstream tag is later re-pointed at a new commit, the cached clone used to
 * silently keep serving the old commit. The fix in fetch-sources.ts adds
 * `git fetch --tags --force origin` before the named-ref fetch so the local
 * tag ref tracks the upstream move.
 */


import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { PERMISSIONS_ENFORCED } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fetchSource } from '../../src/compat-empirical/corpus/fetch-sources.js';
import type { CorpusEntry } from '../../src/compat-empirical/types.js';

const TEST_TAG = 'v0.0.1-test';
const SKILL_FILE = 'SKILL.md';

let tmpRoot: string;
let bareRemotePath: string;
let upstreamWorkPath: string;
let cacheDir: string;

function runGit(cwd: string, args: string[]): string {
  return runGitOrThrow(args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'vat-test',
      GIT_AUTHOR_EMAIL: 'vat-test@example.invalid',
      GIT_COMMITTER_NAME: 'vat-test',
      GIT_COMMITTER_EMAIL: 'vat-test@example.invalid',
    },
  }).toString();
}

function makeCommit(content: string): void {
  writeFileSync(safePath.join(upstreamWorkPath, SKILL_FILE), content, 'utf8');
  runGit(upstreamWorkPath, ['add', SKILL_FILE]);
  runGit(upstreamWorkPath, ['commit', '-m', `snapshot: ${content}`]);
}

function moveTag(target: 'HEAD'): void {
  // -f forces the local annotated tag to move; the push below carries it to the bare remote.
  runGit(upstreamWorkPath, ['tag', '-fa', TEST_TAG, target, '-m', 'moved']);
  runGit(upstreamWorkPath, ['push', '--force', 'origin', `refs/tags/${TEST_TAG}`]);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-fetch-sources-test-'));
  bareRemotePath = safePath.join(tmpRoot, 'remote.git');
  upstreamWorkPath = safePath.join(tmpRoot, 'upstream');
  cacheDir = safePath.join(tmpRoot, 'cache');

  runGit(tmpRoot, ['init', '--bare', '--initial-branch=main', 'remote.git']);
  runGit(tmpRoot, ['clone', '--quiet', bareRemotePath, 'upstream']);

  makeCommit('initial');
  runGit(upstreamWorkPath, ['tag', '-a', TEST_TAG, '-m', 'initial']);
  runGit(upstreamWorkPath, ['push', 'origin', 'main', `refs/tags/${TEST_TAG}`]);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('refreshGitRef (moved annotated tag regression)', () => {
  it('returns the new tag commit after the upstream tag moves', async () => {
    const entry: CorpusEntry = {
      id: 'tag-test',
      bucket: 'own',
      source: { kind: 'git', repo: pathToFileURL(bareRemotePath).href, ref: TEST_TAG },
      skillRelPath: SKILL_FILE,
      expectedCapabilities: [],
      triggerPromptRefs: ['pos', 'neg'],
    };

    const first = await fetchSource(entry, tmpRoot, { cacheDir });
    expect(readFileSync(first.skillPath, 'utf8')).toBe('initial');

    makeCommit('updated');
    moveTag('HEAD');

    const second = await fetchSource(entry, tmpRoot, { cacheDir });
    // Without `git fetch --tags --force`, this assertion is the regression
    // signal: the staged checkout would still be `initial`.
    expect(readFileSync(second.skillPath, 'utf8')).toBe('updated');
  });
});

/** A local skill source under this test's root: one SKILL.md. */
function writeLocalSource(): string {
  const source = safePath.join(tmpRoot, 'local-skill');
  mkdirSyncReal(source, { recursive: true });
  writeFileSync(safePath.join(source, SKILL_FILE), 'local', 'utf8');
  return source;
}

describe('stageLocal', () => {
  const entry: CorpusEntry = {
    id: 'local-test',
    bucket: 'own',
    source: { kind: 'local', path: 'local-skill' },
    skillRelPath: SKILL_FILE,
    expectedCapabilities: [],
    triggerPromptRefs: ['pos', 'neg'],
  };

  it('stages a copy of the local source, and reuses it once staged', async () => {
    const source = writeLocalSource();

    const first = await fetchSource(entry, tmpRoot, { cacheDir });
    expect(readFileSync(first.skillPath, 'utf8')).toBe('local');
    expect(first.rootDir).not.toBe(source);

    writeFileSync(safePath.join(source, SKILL_FILE), 'edited', 'utf8');
    const second = await fetchSource(entry, tmpRoot, { cacheDir });
    expect(readFileSync(second.skillPath, 'utf8')).toBe('local');
  });

  // A half-copied stage directory would be reused on every later run as if complete.
  it.skipIf(!PERMISSIONS_ENFORCED)('leaves no stage directory behind when the source cannot be copied', async () => {
    const source = writeLocalSource();
    const unreadable = safePath.join(source, 'secret.md');
    writeFileSync(unreadable, 'x', { mode: 0o000 });

    try {
      await expect(fetchSource(entry, tmpRoot, { cacheDir })).rejects.toThrow();
    } finally {
      chmodSync(unreadable, 0o644);
    }
    expect(existsSync(safePath.join(cacheDir, 'local', entry.id))).toBe(false);
  });
});
