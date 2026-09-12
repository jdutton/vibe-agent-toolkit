/**
 * `vat claude marketplace validate` must never answer `success` for a run that
 * validated none of the plugins the manifest says it ships.
 *
 * ## The defect
 *
 * `validatePlugins` walked `plugins/` and returned nothing when the directory
 * was absent — which is NORMAL for a marketplace whose entries are all
 * git/npm-sourced, and fatal for one whose entries are relative paths. The
 * document published no count at all, so a reader had no denominator: "three
 * local plugins, all clean" and "three local plugins, none looked at" were the
 * same bytes, `status: success`, exit 0.
 *
 * ## What zero means here, and why the refusal is narrow
 *
 * The manifest itself IS validated on every run, so "nothing was checked" is
 * never literally true once the manifest parses. The refusal therefore fires on
 * exactly one shape: the manifest declares at least one plugin with a LOCAL
 * source (a relative path — a plugin this marketplace ships itself) and the run
 * validated NO plugin. A marketplace whose entries are all remote legitimately
 * has nothing local to inspect and stays green; a marketplace with no entries
 * at all likewise.
 *
 * ## Why the assertion is on the builder
 *
 * `buildMarketplaceValidateReport` is the one function every emission — bail or
 * full run, command line or `vat verify` phase — passes through, and it now
 * derives `status` from the issues it publishes, so "local plugins declared,
 * none validated, status clean" is unrepresentable rather than merely
 * unwritten. Pure, so no marketplace on disk is needed to pin it.
 */

import { describe, expect, it } from 'vitest';

import {
  buildMarketplaceValidateReport,
  type MarketplaceValidateReportInput,
} from '../../../../src/commands/claude/marketplace/validate.js';

/** The code the run-integrity refusal carries, shared with every other gate. */
const RUN_INTEGRITY_CODE = 'RESOURCE_CHECK_BROKEN';

/** One inspected plugin, clean — enough to make the denominator non-zero. */
const CLEAN_PLUGIN = {
  path: '/mp-nc/plugins/alpha',
  type: 'claude-plugin',
  status: 'success',
  summary: 'Valid plugin',
  issues: [],
  issueCounts: { errors: 0, warnings: 0, info: 0 },
  metadata: { name: 'alpha' },
} as const;

/**
 * A report over a marketplace that validated `validated` plugins out of the
 * `local` local-source entries its manifest declares (`entries` in total).
 *
 * ONE builder for every case — control included — so a case cannot differ from
 * its neighbour in a field nobody meant to change.
 */
function reportFor(
  local: number,
  entries: number,
  validated: 0 | 1,
  issues: MarketplaceValidateReportInput['issues'] = [],
): Record<string, unknown> {
  return buildMarketplaceValidateReport({
    root: '/mp-nc',
    marketplace: { name: 'mp', pluginEntries: entries, localPluginEntries: local },
    pluginResults: validated === 0 ? [] : [CLEAN_PLUGIN],
    issues,
    duration: '3ms',
  });
}

describe('marketplace validate — local plugins declared, none validated', () => {
  it('refuses with ONE RESOURCE_CHECK_BROKEN at error and publishes the zero denominator', () => {
    // 🔑 The reproduced defect. Delete the guard and this reds: no issue was
    // collected, so the document reads `status: success` beside nothing that
    // says three plugins went unlooked-at.
    const data = reportFor(3, 3, 0);

    expect(data['status']).toBe('error');
    expect(data['pluginsValidated']).toBe(0);
    expect(data['issueCounts']).toEqual({ errors: 1, warnings: 0, info: 0 });
    expect(data['issues']).toEqual([
      { unlocated: true, errors: 1, codes: { [RUN_INTEGRITY_CODE]: 1 } },
    ]);
  });

  it('says how many local plugins went unvalidated and where the walk looked', () => {
    const data = buildMarketplaceValidateReport({
      root: '/mp-nc',
      marketplace: { name: 'mp', pluginEntries: 4, localPluginEntries: 3 },
      pluginResults: [],
      issues: [],
      duration: '3ms',
      verbose: true,
    });
    const [finding] = data['issues'] as Array<{ code: string; message: string }>;

    expect(finding?.code).toBe(RUN_INTEGRITY_CODE);
    expect(finding?.message).toContain('3');
    expect(finding?.message).toContain('plugins/');
    // The RUN is not a verdict — the message never claims a plugin is broken.
    expect(finding?.message).not.toMatch(/invalid plugin|broken plugin/i);
  });

  it('stays green for a marketplace whose entries are all remote', () => {
    // 🔑 The guard against the over-correction the brief warns about: a
    // git/npm-sourced marketplace has nothing local to walk, and its manifest
    // WAS validated.
    const data = reportFor(0, 2, 0);

    expect(data['status']).toBe('success');
    expect(data['pluginsValidated']).toBe(0);
    expect(data['issueCounts']).toEqual({ errors: 0, warnings: 0, info: 0 });
    expect(data['issues']).toEqual([]);
  });

  it('stays green for a manifest with no entries at all', () => {
    expect(reportFor(0, 0, 0)['status']).toBe('success');
  });

  it('refuses PARTIAL coverage too: declared 2, validated 1 is two numbers that disagree', () => {
    // 🔑 Nothing in the marketplace package checks that a declared local source
    // directory exists, so "declares 2, validated 1" is one plugin silently
    // unvalidated at exit 0 — the same class as zero, one step in.
    const data = buildMarketplaceValidateReport({
      root: '/mp-nc',
      marketplace: { name: 'mp', pluginEntries: 2, localPluginEntries: 2 },
      pluginResults: [CLEAN_PLUGIN],
      issues: [],
      duration: '3ms',
      verbose: true,
    });
    const [finding] = data['issues'] as Array<{ code: string; message: string }>;

    expect(data['status']).toBe('error');
    expect(data['pluginsValidated']).toBe(1);
    expect(data['issueCounts']).toEqual({ errors: 1, warnings: 0, info: 0 });
    expect(finding?.code).toBe(RUN_INTEGRITY_CODE);
    // Both numbers, so the reader sees the gap without opening the manifest.
    expect(finding?.message).toContain('2 plugin(s)');
    expect(finding?.message).toContain('validated 1');
  });

  it('stays silent once every declared local plugin was validated', () => {
    // 🔑 The positive control for the partial-coverage arm: declared 1,
    // validated 1 is full coverage, and a real finding is the only way it gates.
    const data = reportFor(1, 1, 1);

    expect(data['status']).toBe('success');
    expect(data['pluginsValidated']).toBe(1);
    expect(data['issues']).toEqual([]);
  });

  it('tolerates a walk that found MORE directories than the manifest declares', () => {
    // A `plugins/` dir may hold a directory the manifest does not list; that is
    // a different question (an undeclared plugin), not an unvalidated one.
    expect(reportFor(0, 0, 1)['status']).toBe('success');
  });

  it('derives status from the issues it publishes, so a promoted finding gates', () => {
    // The builder now owns the status derivation; a caller can no longer hand
    // it a `status` that disagrees with `issues`.
    const data = reportFor(1, 1, 1, [
      { code: 'PLUGIN_MISSING_VERSION', severity: 'error', message: 'no version', location: 'plugins/alpha/.claude-plugin/plugin.json' },
    ]);

    expect(data['status']).toBe('error');
    expect(data['issueCounts']).toEqual({ errors: 1, warnings: 0, info: 0 });
    expect(data['summary']).toBe('1 error(s), 0 warning(s), 0 info');
  });

  it('keeps the manifest\'s own summary on the bail path, and no refusal beside it', () => {
    // A manifest that failed to parse carries no entry counts, so nothing is
    // "expected" — the manifest error is the whole finding, and the refusal
    // must not pile a second report on top of it.
    const data = buildMarketplaceValidateReport({
      root: '/mp-nc',
      marketplace: undefined,
      pluginResults: [],
      issues: [{ code: 'MARKETPLACE_MISSING_MANIFEST', severity: 'error', message: 'missing' }],
      bailSummary: 'Marketplace manifest missing',
      duration: '2ms',
    });

    expect(data['status']).toBe('error');
    expect(data['summary']).toBe('Marketplace manifest missing');
    expect(data['issueCounts']).toEqual({ errors: 1, warnings: 0, info: 0 });
  });
});
