/* eslint-disable security/detect-non-literal-fs-filename -- tmpdir paths constructed in test setup */
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveVendoredSource } from '../../src/skill-source/sources/vendored-source.js';
import type { ResolveSkillSourceContext } from '../../src/skill-source/types.js';

describe('resolveVendoredSource', () => {
  let root: string;
  let vendored: string;
  let ctx: ResolveSkillSourceContext;

  beforeEach(() => {
    root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-vend-'));
    vendored = safePath.join(root, 'vendor', 'skill-creator');
    mkdirSyncReal(vendored, { recursive: true });
    writeFileSync(safePath.join(vendored, 'SKILL.md'), '# skill-creator');
    ctx = {
      repoRoot: root,
      stagingRoot: safePath.join(root, 'staging'),
      fetchCacheDir: safePath.join(root, 'cache'),
      vendoredDir: vendored,
    };
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('stages the vendored copy and records a manifest hash identity', async () => {
    const result = await resolveVendoredSource(ctx);
    expect(statSync(safePath.join(result.stagedDir, 'SKILL.md')).isFile()).toBe(true);
    expect(result.identity).toMatch(/^vendored:[0-9a-f]{64}$/);
  });

  it('throws when ctx.vendoredDir is not provided', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { vendoredDir, ...rest } = ctx;
    // Create ctx without vendoredDir to test error handling
    type ContextWithoutVendored = Omit<ResolveSkillSourceContext, 'vendoredDir'>;
    await expect(resolveVendoredSource(rest as ContextWithoutVendored)).rejects.toThrow(
      /vendoredDir/i,
    );
  });
});
