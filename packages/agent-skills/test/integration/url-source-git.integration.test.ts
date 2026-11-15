import { readFileSync, statSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

import { GIT_CLONE_FAILED_CODE } from '../../src/skill-source/git-clone.js';
import { resolveUrlSource } from '../../src/skill-source/sources/url-source.js';
import { SKILL_TEST_REFUSAL_BY_ERROR_CODE } from '../../src/skill-test/failure-reason.js';
import { makeBareRepoWithSkill, setupSkillSourceTestSuite } from '../skill-source/test-helpers.js';
import { useScratchTmpdir } from '../test-helpers.js';

// ⛔ Disposal paths: TMPDIR / TEMP / TMP point at a scratch tree for every test (and every child
// a test spawns), so neither the run nor a mutation of its cleanup can reach the real temp dir.
useScratchTmpdir('vat-scratch-10-');

// Integration tier: every test here spawns real git (bare repo fixtures plus a
// clone per resolve). In the unit tier the fixture hook outran its 10 s timeout
// whenever the gate itself loaded the machine. The zip arm stays a unit test.

let bareUrl: string;
let fixtureCleanup: () => void;

beforeAll(() => {
  const fixture = makeBareRepoWithSkill({ skillContent: '# git skill' });
  bareUrl = `${fixture.bareUrl}#main`;
  fixtureCleanup = fixture.cleanup;
});

afterAll(() => {
  fixtureCleanup();
});

const suite = setupSkillSourceTestSuite('vat-url-git-');
beforeEach(suite.beforeEach);
afterEach(suite.afterEach);

it('resolves a git url via the extracted clone and stages the SKILL.md', async () => {
  const result = await resolveUrlSource(bareUrl, undefined, suite.ctx);
  expect(statSync(safePath.join(result.stagedDir, 'SKILL.md')).isFile()).toBe(true);
  expect(result.identity).toMatch(/^url:/);
});

it('serves a git url from the warm cache on a second resolve', async () => {
  // First resolve populates the commit-keyed cache entry; the second resolve
  // exercises the cache-hit arm (no re-clone into the cache, verify is a no-op).
  const first = await resolveUrlSource(bareUrl, undefined, suite.ctx);
  const second = await resolveUrlSource(bareUrl, undefined, suite.ctx);
  expect(second.identity).toBe(first.identity);
  expect(statSync(safePath.join(second.stagedDir, 'SKILL.md')).isFile()).toBe(true);
});

it('keys the git cache on the full url so two distinct repos never cross-contaminate (M3)', async () => {
  // Two independent bare repos with DIFFERENT content. A basename-only cache key
  // would risk a collision; the full-url hash key must keep them distinct.
  const repoA = makeBareRepoWithSkill({ skillContent: '# repo A skill' });
  const repoB = makeBareRepoWithSkill({ skillContent: '# repo B skill' });
  try {
    const a = await resolveUrlSource(`${repoA.bareUrl}#main`, undefined, suite.ctx);
    const b = await resolveUrlSource(`${repoB.bareUrl}#main`, undefined, suite.ctx);
    expect(a.identity).not.toBe(b.identity);
    expect(readFileSync(safePath.join(a.stagedDir, 'SKILL.md'), 'utf-8')).toBe('# repo A skill');
    expect(readFileSync(safePath.join(b.stagedDir, 'SKILL.md'), 'utf-8')).toBe('# repo B skill');
  } finally {
    repoA.cleanup();
    repoB.cleanup();
  }
});

// What is cached and staged is the SUBPATH's tree. Keyed on the clone url and the commit alone, the
// second of two subpaths of one commit was a cache hit on the first's tree: `skills/b` resolved to
// `skills/a`'s files, under an identity naming `skills/b`.
it('keys the cache entry and the staged directory on the ref and subpath: two subpaths of one commit are two trees', async () => {
  const repo = makeBareRepoWithSkill({
    skillSubdir: 'skills/a',
    skillContent: '# skill A',
    beforeCommit: (workDir) => {
      mkdirSyncReal(safePath.join(workDir, 'skills', 'b'), { recursive: true });
      writeFileSync(safePath.join(workDir, 'skills', 'b', 'SKILL.md'), '# skill B');
    },
  });
  try {
    const a = await resolveUrlSource(`${repo.bareUrl}#main:skills/a`, undefined, suite.ctx);
    const b = await resolveUrlSource(`${repo.bareUrl}#main:skills/b`, undefined, suite.ctx);

    expect(b.stagedDir).not.toBe(a.stagedDir);
    expect(readFileSync(safePath.join(a.stagedDir, 'SKILL.md'), 'utf-8')).toBe('# skill A');
    expect(readFileSync(safePath.join(b.stagedDir, 'SKILL.md'), 'utf-8')).toBe('# skill B');
    // Under --refresh too: the cache is rewritten, and the two still must not share one staged directory.
    const refreshed = { ...suite.ctx, refresh: true };
    await resolveUrlSource(`${repo.bareUrl}#main:skills/a`, undefined, refreshed);
    const again = await resolveUrlSource(`${repo.bareUrl}#main:skills/b`, undefined, refreshed);
    expect(readFileSync(safePath.join(again.stagedDir, 'SKILL.md'), 'utf-8')).toBe('# skill B');
  } finally {
    repo.cleanup();
  }
});

// A clone that did not happen is the source's refusal, coded: uncoded, the CLI published it as a defect in VAT.
it('refuses a repository that cannot be cloned with a coded refusal the operator can fix', async () => {
  const error = await resolveUrlSource(`${bareUrl.replace('#main', '')}#no-such-branch`, undefined, suite.ctx).then(() => undefined, (thrown: unknown) => thrown);

  expect(error).toMatchObject({ code: GIT_CLONE_FAILED_CODE, message: expect.stringMatching(/Reference not found/) });
  expect(SKILL_TEST_REFUSAL_BY_ERROR_CODE[GIT_CLONE_FAILED_CODE]).toBe('INPUT_UNREADABLE');
});

it('embeds the full 40-char commit SHA in a git url identity (M3)', async () => {
  const result = await resolveUrlSource(bareUrl, undefined, suite.ctx);
  expect(result.identity).toMatch(/^url:.*:[0-9a-f]{40}$/);
});
