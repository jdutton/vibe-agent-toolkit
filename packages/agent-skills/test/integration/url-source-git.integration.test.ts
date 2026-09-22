import { readFileSync, statSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

import { resolveUrlSource } from '../../src/skill-source/sources/url-source.js';
import { makeBareRepoWithSkill, setupSkillSourceTestSuite } from '../skill-source/test-helpers.js';

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

it('embeds the full 40-char commit SHA in a git url identity (M3)', async () => {
  const result = await resolveUrlSource(bareUrl, undefined, suite.ctx);
  expect(result.identity).toMatch(/^url:.*:[0-9a-f]{40}$/);
});
