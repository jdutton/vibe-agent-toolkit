/* eslint-disable security/detect-non-literal-fs-filename -- tmpdir paths constructed in test setup */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import AdmZip from 'adm-zip';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { resolveUrlSource, sha256Of } from '../../src/skill-source/sources/url-source.js';
import type { ResolveSkillSourceContext } from '../../src/skill-source/types.js';

import { makeBareRepoWithSkill } from './test-helpers.js';

/** SKILL.md body packed into the zip fixture and asserted on extraction. */
const ZIP_SKILL_BODY = '# zip skill';

let root: string;
let bareUrl: string;
let zipPath: string;
let zipSha: string;
let ctx: ResolveSkillSourceContext;
let gitFixtureCleanup: () => void;

beforeAll(() => {
  root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-url-'));
  ctx = {
    repoRoot: root,
    stagingRoot: safePath.join(root, 'staging'),
    fetchCacheDir: safePath.join(root, 'cache'),
  };

  // git fixture — bare repo with a SKILL.md at the root
  const gitFixture = makeBareRepoWithSkill({ skillContent: '# git skill' });
  bareUrl = `${gitFixture.bareUrl}#main`;
  gitFixtureCleanup = gitFixture.cleanup;

  // zip fixture
  const zip = new AdmZip();
  zip.addFile('SKILL.md', Buffer.from(ZIP_SKILL_BODY));
  zipPath = safePath.join(root, 'skill.zip');
  zip.writeZip(zipPath);
  zipSha = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
});

afterAll(() => {
  gitFixtureCleanup();
  rmSync(root, { recursive: true, force: true });
});

it('resolves a git url via the extracted clone and stages the SKILL.md', async () => {
  const result = await resolveUrlSource(bareUrl, undefined, ctx);
  expect(statSync(safePath.join(result.stagedDir, 'SKILL.md')).isFile()).toBe(true);
  expect(result.identity).toMatch(/^url:/);
});

it('resolves a .zip file url, verifies sha256, and stages it', async () => {
  const fileUrl = pathToFileURL(zipPath).href;
  const result = await resolveUrlSource(fileUrl, zipSha, ctx);
  expect(readFileSync(safePath.join(result.stagedDir, 'SKILL.md'), 'utf-8')).toBe(ZIP_SKILL_BODY);
  expect(result.identity).toBe(`url:${fileUrl}:${zipSha}`);
});

it('rejects a .zip whose sha256 does not match', async () => {
  const fileUrl = pathToFileURL(zipPath).href;
  await expect(resolveUrlSource(fileUrl, 'deadbeef'.repeat(8), ctx)).rejects.toThrow(/sha256|integrity/i);
});

it('requires sha256 for a .zip url', async () => {
  const fileUrl = pathToFileURL(zipPath).href;
  await expect(resolveUrlSource(fileUrl, undefined, ctx)).rejects.toThrow(/sha256/i);
});

it('serves a git url from the warm cache on a second resolve', async () => {
  // First resolve populates the commit-keyed cache entry; the second resolve
  // exercises the cache-hit arm (no re-clone into the cache, verify is a no-op).
  const first = await resolveUrlSource(bareUrl, undefined, ctx);
  const second = await resolveUrlSource(bareUrl, undefined, ctx);
  expect(second.identity).toBe(first.identity);
  expect(statSync(safePath.join(second.stagedDir, 'SKILL.md')).isFile()).toBe(true);
});

it('serves a .zip url from the warm cache on a second resolve', async () => {
  const fileUrl = pathToFileURL(zipPath).href;
  const first = await resolveUrlSource(fileUrl, zipSha, ctx);
  const second = await resolveUrlSource(fileUrl, zipSha, ctx);
  expect(second.identity).toBe(first.identity);
  expect(readFileSync(safePath.join(second.stagedDir, 'SKILL.md'), 'utf-8')).toBe(ZIP_SKILL_BODY);
});

it('keys the git cache on the full url so two distinct repos never cross-contaminate (M3)', async () => {
  // Two independent bare repos with DIFFERENT content. A basename-only cache key
  // would risk a collision; the full-url hash key must keep them distinct.
  const repoA = makeBareRepoWithSkill({ skillContent: '# repo A skill' });
  const repoB = makeBareRepoWithSkill({ skillContent: '# repo B skill' });
  try {
    const a = await resolveUrlSource(`${repoA.bareUrl}#main`, undefined, ctx);
    const b = await resolveUrlSource(`${repoB.bareUrl}#main`, undefined, ctx);
    expect(a.identity).not.toBe(b.identity);
    expect(readFileSync(safePath.join(a.stagedDir, 'SKILL.md'), 'utf-8')).toBe('# repo A skill');
    expect(readFileSync(safePath.join(b.stagedDir, 'SKILL.md'), 'utf-8')).toBe('# repo B skill');
  } finally {
    repoA.cleanup();
    repoB.cleanup();
  }
});

it('embeds the full 40-char commit SHA in a git url identity (M3)', async () => {
  const result = await resolveUrlSource(bareUrl, undefined, ctx);
  expect(result.identity).toMatch(/^url:.*:[0-9a-f]{40}$/);
});

it('exposes sha256Of computing the same digest used for zip integrity', () => {
  const bytes = readFileSync(zipPath);
  expect(sha256Of(bytes)).toBe(zipSha);
});
