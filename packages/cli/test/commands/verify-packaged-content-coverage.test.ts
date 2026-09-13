/**
 * `vat verify`'s `packaged-content` phase must not answer `success` over a
 * PARTIALLY built `dist/`.
 *
 * ## The defect
 *
 * The phase's denominator was `bundlesInspected` — the bundles that EXIST on
 * disk — and the only refusal was `bundlesInspected === 0`. Two discovered
 * skills, `vat build`, `rm -rf dist/skills/beta` ⇒ `status: success,
 * bundlesInspected: 1`, exit 0. The zero-bundle docstring says "a run that
 * found none of it is not a verdict on it"; a run that found half of it was
 * published as one, with nothing in the document saying which half.
 *
 * The crawl now carries `bundlesExpected` (what `vat build` produces for the
 * skills this run discovered) and `bundlesMissing` (the expected bundles whose
 * output dir was absent, by root-relative path), and the builder refuses a
 * non-empty `bundlesMissing` through the same run-integrity mechanism the zero
 * case uses: ONE non-overridable `RESOURCE_CHECK_BROKEN` at `error`, naming
 * the missing bundles.
 */

import { describe, expect, it } from 'vitest';

import { exitCodeForPhases } from '../../src/commands/phase-utils.js';
import { buildPackagedContentPhase, type PackagedContentCrawl } from '../../src/commands/verify.js';

const RUN_INTEGRITY_CODE = 'RESOURCE_CHECK_BROKEN';
const BETA_BUNDLE = 'dist/skills/beta';

function crawlOf(overrides: Partial<PackagedContentCrawl>): PackagedContentCrawl {
  return { bundlesInspected: 0, bundlesExpected: 0, bundlesMissing: [], issues: [], ...overrides };
}

describe('buildPackagedContentPhase — a phase over PART of the build is not a verdict', () => {
  it('refuses a missing expected bundle by name, as ONE run-integrity error', () => {
    // 🔑 The reproduced case: two skills discovered, one bundle deleted.
    const phase = buildPackagedContentPhase(crawlOf({
      bundlesInspected: 1,
      bundlesExpected: 2,
      bundlesMissing: [BETA_BUNDLE],
    }));

    expect(phase.status).toBe('error');
    expect(phase.bundlesInspected).toBe(1);
    expect(phase.bundlesExpected).toBe(2);
    expect(phase.bundlesMissing).toEqual([BETA_BUNDLE]);
    expect(phase.issueCounts).toEqual({ errors: 1, warnings: 0, info: 0 });
    expect(phase.issues.map((i) => [i.code, i.severity])).toEqual([[RUN_INTEGRITY_CODE, 'error']]);
    const message = phase.issues[0]?.message ?? '';
    expect(message).toContain(BETA_BUNDLE);
    expect(message).toContain('vat build');
    // The exit code the orchestrator derives from this document.
    expect(exitCodeForPhases([phase])).toBe(1);
  });

  it('names EVERY missing bundle, not just the first', () => {
    const phase = buildPackagedContentPhase(crawlOf({
      bundlesInspected: 1,
      bundlesExpected: 3,
      bundlesMissing: [BETA_BUNDLE, 'dist/.claude/plugins/marketplaces/m/plugins/p/skills/gamma'],
    }));

    expect(phase.issues).toHaveLength(1);
    const message = phase.issues[0]?.message ?? '';
    expect(message).toContain(BETA_BUNDLE);
    expect(message).toContain('plugins/p/skills/gamma');
  });

  it('stays silent and publishes matching counts when every expected bundle was inspected', () => {
    // 🔑 The over-correction guard: the control arm of the reproduced case.
    const phase = buildPackagedContentPhase(crawlOf({ bundlesInspected: 2, bundlesExpected: 2 }));

    expect(phase.status).toBe('success');
    expect(phase.bundlesInspected).toBe(2);
    expect(phase.bundlesExpected).toBe(2);
    expect(phase.bundlesMissing).toEqual([]);
    expect(phase.issues).toEqual([]);
    expect(exitCodeForPhases([phase])).toBe(0);
  });

  it('reports ONE refusal, not two, when nothing at all was built', () => {
    // Both refusals apply (zero inspected AND bundles missing); invariant 4 of
    // run-integrity.ts says one report per run. The one that names the missing
    // bundles wins, because it says more.
    const phase = buildPackagedContentPhase(crawlOf({
      bundlesInspected: 0,
      bundlesExpected: 2,
      bundlesMissing: ['dist/skills/alpha', BETA_BUNDLE],
    }));

    expect(phase.status).toBe('error');
    expect(phase.issues.map((i) => i.code)).toEqual([RUN_INTEGRITY_CODE]);
    expect(phase.issues[0]?.message).toContain('dist/skills/alpha');
    expect(phase.issues[0]?.message).toContain(BETA_BUNDLE);
  });

  it('keeps the zero-bundle refusal for a run that discovered nothing to expect', () => {
    // A typo'd glob: nothing discovered, nothing expected, nothing missing —
    // still not a verdict, and still refused through the original message.
    const phase = buildPackagedContentPhase(crawlOf({}));

    expect(phase.status).toBe('error');
    expect(phase.issues.map((i) => i.code)).toEqual([RUN_INTEGRITY_CODE]);
    expect(phase.issues[0]?.message).toContain('inspected 0 built skill bundles');
  });
});
