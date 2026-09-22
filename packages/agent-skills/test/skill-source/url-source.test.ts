import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import AdmZip from 'adm-zip';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { resolveUrlSource, sha256Of } from '../../src/skill-source/sources/url-source.js';
import type { ResolveSkillSourceContext } from '../../src/skill-source/types.js';

// The git-url arm spawns real git (bare repo + clone) and lives in the
// integration tier: test/integration/url-source-git.integration.test.ts.

/** SKILL.md body packed into the zip fixture and asserted on extraction. */
const ZIP_SKILL_BODY = '# zip skill';

let root: string;
let zipPath: string;
let zipSha: string;
let ctx: ResolveSkillSourceContext;

beforeAll(() => {
  root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-url-'));
  ctx = {
    repoRoot: root,
    stagingRoot: safePath.join(root, 'staging'),
    fetchCacheDir: safePath.join(root, 'cache'),
  };

  const zip = new AdmZip();
  zip.addFile('SKILL.md', Buffer.from(ZIP_SKILL_BODY));
  zipPath = safePath.join(root, 'skill.zip');
  zip.writeZip(zipPath);
  zipSha = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
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

it('serves a .zip url from the warm cache on a second resolve', async () => {
  const fileUrl = pathToFileURL(zipPath).href;
  const first = await resolveUrlSource(fileUrl, zipSha, ctx);
  const second = await resolveUrlSource(fileUrl, zipSha, ctx);
  expect(second.identity).toBe(first.identity);
  expect(readFileSync(safePath.join(second.stagedDir, 'SKILL.md'), 'utf-8')).toBe(ZIP_SKILL_BODY);
});

it('exposes sha256Of computing the same digest used for zip integrity', () => {
  const bytes = readFileSync(zipPath);
  expect(sha256Of(bytes)).toBe(zipSha);
});
