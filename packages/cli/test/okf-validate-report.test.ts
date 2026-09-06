/**
 * Unit tests for the `vat okf validate` report summary.
 *
 * 🪤 The defect these exist for: with no `okf.bundles` declared, the command
 * printed `status: passed`, `bundles: []`, and exited 0 — saying nothing at all
 * about the fact that it had checked nothing. A mistyped config key
 * (`okf.bundle:`, `okf.Bundles:`) therefore reads as a clean bill of health,
 * which is the *green-without-running* shape this repo keeps finding.
 *
 * `vat resources check` already had the right answer for the identical
 * situation — it prints "No checks are declared. Add them under
 * `resources.checks` …" — so this is bringing one command in line with a
 * convention the repo already holds, not inventing a policy.
 *
 * Exit code stays 0 on purpose: nothing failed. It is the *status word* that
 * must not claim a pass, because that word is what a human and a CI log reader
 * actually see.
 */
import type { OkfBundleReport, OkfFinding } from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import { summarizeOkfBundles } from '../src/commands/okf/validate.js';

function finding(severity: OkfFinding['severity']): OkfFinding {
  return {
    code: 'OKF_FRONTMATTER_MISSING',
    severity,
    message: 'no frontmatter',
    document: 'concepts/a.md',
  };
}

function report(bundle: string, findings: OkfFinding[] = []): OkfBundleReport {
  return {
    bundle,
    root: `/bundles/${bundle}`,
    conceptDocuments: ['concepts/a.md'],
    reservedDocuments: [],
    findings,
    hasErrors: findings.some((f) => f.severity === 'error'),
  };
}

describe('summarizeOkfBundles', () => {
  it('reports no-bundles, not passed, when nothing was declared', () => {
    const summary = summarizeOkfBundles([]);

    expect(summary.status).toBe('no-bundles');
    expect(summary.findingCount).toBe(0);
    expect(summary.errorCount).toBe(0);
  });

  it('names the config key to add, so the fix does not need a docs lookup', () => {
    const summary = summarizeOkfBundles([]);

    expect(summary.notice).toBeDefined();
    expect(summary.notice).toContain('okf.bundles');
  });

  it('passes when a declared bundle produced no findings', () => {
    const summary = summarizeOkfBundles([report('knowledge')]);

    expect(summary.status).toBe('passed');
    expect(summary.notice).toBeUndefined();
  });

  it('fails on an error-severity finding', () => {
    const summary = summarizeOkfBundles([report('knowledge', [finding('error')])]);

    expect(summary.status).toBe('failed');
    expect(summary.errorCount).toBe(1);
    expect(summary.findingCount).toBe(1);
  });

  it('passes, but still counts, when every finding is below error', () => {
    const summary = summarizeOkfBundles([
      report('knowledge', [finding('warning'), finding('info')]),
    ]);

    expect(summary.status).toBe('passed');
    expect(summary.errorCount).toBe(0);
    expect(summary.findingCount).toBe(2);
  });

  it('counts across every bundle, not just the first', () => {
    const summary = summarizeOkfBundles([
      report('a', [finding('error')]),
      report('b', [finding('error'), finding('warning')]),
    ]);

    expect(summary.errorCount).toBe(2);
    expect(summary.findingCount).toBe(3);
    expect(summary.status).toBe('failed');
  });

  it('distinguishes an empty declaration from a declared-but-empty bundle', () => {
    // A bundle root that exists and holds no concept documents is a real,
    // checked result. It must NOT collapse into the same word as "you declared
    // nothing" — that collapse is what made the original defect invisible.
    const summary = summarizeOkfBundles([report('empty-but-declared')]);

    expect(summary.status).toBe('passed');
    expect(summary.status).not.toBe('no-bundles');
  });
});
