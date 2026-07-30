import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { crawlAndResolveRegistry } from '../../src/validators/packaging-validator.js';

/**
 * Building this registry parses EVERY markdown and HTML document under the
 * project root. On a 1039-document monorepo that is ~12 seconds, and the
 * packager's post-build validation calls it once per skill — so a 46-skill
 * plugin build paid it 46 times, a fixed per-skill cost independent of the
 * skill's own size. Both build phases hit it: `vat skills build` and
 * `vat claude plugin build` each share their PACKAGING registry, then every
 * `packageSkill` re-crawls the project for post-build validation anyway.
 *
 * The memo lives here, next to the crawl, rather than in each caller: `vat audit`
 * had already solved this with its own private cache keyed on a project-root
 * string it had to derive the same way the validator does — its own comment warns
 * that "a mismatched key silently degrades back to a per-skill crawl". Keying on
 * the RESOLVED path in one place removes both the duplication and that trap.
 */
describe('crawlAndResolveRegistry — memoized per project root', () => {
  let rootA: string;
  let rootB: string;

  beforeAll(() => {
    rootA = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-registry-memo-a-'));
    rootB = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-registry-memo-b-'));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- mkdtempSync path
    writeFileSync(safePath.join(rootA, 'a.md'), '# A\n');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- mkdtempSync path
    writeFileSync(safePath.join(rootB, 'b.md'), '# B\n');
  });

  afterAll(() => {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  });

  it('returns the same registry instance for a repeated root', async () => {
    const first = await crawlAndResolveRegistry(rootA);
    const second = await crawlAndResolveRegistry(rootA);

    expect(second).toBe(first);
  });

  it('keys on the resolved path, so a non-normalized spelling still hits', async () => {
    const first = await crawlAndResolveRegistry(rootA);
    const viaDotSegment = await crawlAndResolveRegistry(`${rootA}/./`);

    expect(viaDotSegment).toBe(first);
  });

  it('does not share a registry across different roots', async () => {
    const a = await crawlAndResolveRegistry(rootA);
    const b = await crawlAndResolveRegistry(rootB);

    // Sharing across roots is the failure the caller-side cache guarded against:
    // every `getResource()` lookup would miss and the walker would walk an empty
    // graph, reporting a clean skill because it never looked.
    expect(b).not.toBe(a);
    expect(a.baseDir).not.toBe(b.baseDir);
  });
});
