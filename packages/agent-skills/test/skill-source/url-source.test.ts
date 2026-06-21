/* eslint-disable security/detect-non-literal-fs-filename -- tmpdir paths constructed in test setup */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import AdmZip from 'adm-zip';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { resolveUrlSource } from '../../src/skill-source/sources/url-source.js';
import type { ResolveSkillSourceContext } from '../../src/skill-source/types.js';

import { makeBareRepoWithSkill } from './test-helpers.js';

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
  zip.addFile('SKILL.md', Buffer.from('# zip skill'));
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
  expect(readFileSync(safePath.join(result.stagedDir, 'SKILL.md'), 'utf-8')).toBe('# zip skill');
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
