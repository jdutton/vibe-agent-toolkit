/**
 * `vat claude marketplace validate` must never answer `success` for a run that
 * did not validate a plugin the manifest says it ships.
 *
 * ## The defect, twice
 *
 * `validatePlugins` walked `plugins/` and returned nothing when the directory
 * was absent — which is NORMAL for a marketplace whose entries are all
 * git/npm-sourced, and fatal for one whose entries are relative paths. The
 * document published no count at all, so a reader had no denominator: "three
 * local plugins, all clean" and "three local plugins, none looked at" were the
 * same bytes, `status: success`, exit 0.
 *
 * The first fix compared COUNTS — directories walked against local entries
 * declared — and this suite blessed that: its "MORE directories than declared"
 * case passed `(declared 0, validated 1)` as fine. A count cannot tell
 * "validated the declared plugin" from "validated a different directory", so a
 * manifest declaring `./plugins/a` over a `plugins/` holding only `b` read as
 * 1 ≥ 1 and passed with `a` never inspected; and the co-located `source: "./"`
 * shape, which lives in no `plugins/`, read as 0 < 1 and was refused.
 *
 * ## What the refusal is now
 *
 * By IDENTITY: `marketplace.localPluginSources` lists the manifest's local
 * entries; each `pluginResults[]` names the entry it satisfies. A declared
 * entry with no result did not resolve to a directory and is refused, by name.
 * A marketplace whose entries are all remote has nothing local to resolve and
 * stays green; a marketplace with no entries at all likewise; a directory no
 * entry names is listed under `undeclared` and stays green — it cannot ship.
 *
 * ## Why the assertion is on the builder
 *
 * `buildMarketplaceValidateReport` is the one function every emission — bail or
 * full run, command line or `vat verify` phase — passes through, and it derives
 * `status` from the issues it publishes, so "declared plugin unresolved, status
 * clean" is unrepresentable rather than merely unwritten. Pure, so no
 * marketplace on disk is needed to pin it; the resolution itself is pinned
 * against real trees in `validate-declared-sources.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  buildMarketplaceValidateReport,
  type LocalPluginResult,
  type LocalPluginSource,
  type MarketplaceValidateReportInput,
} from '../../../../src/commands/claude/marketplace/validate.js';

/** The code the run-integrity refusal carries, shared with every other gate. */
const RUN_INTEGRITY_CODE = 'RESOURCE_CHECK_BROKEN';

const ALPHA: LocalPluginSource = { name: 'alpha', source: './plugins/alpha' };
const BETA: LocalPluginSource = { name: 'beta', source: './plugins/beta' };

/** A clean result for the declared plugin `entry`. */
function validated(entry: LocalPluginSource): LocalPluginResult {
  return {
    ...entry,
    result: {
      path: `/mp-nc/${entry.source}`,
      type: 'claude-plugin',
      status: 'success',
      summary: 'Valid plugin',
      issues: [],
      issueCounts: { errors: 0, warnings: 0, info: 0 },
      metadata: { name: entry.name },
    },
  };
}

/**
 * A report over a marketplace whose manifest declares `local` (among `entries`
 * entries in total) and whose run validated `results`.
 *
 * ONE builder for every case — control included — so a case cannot differ from
 * its neighbour in a field nobody meant to change.
 */
function reportFor(
  local: readonly LocalPluginSource[],
  entries: number,
  results: readonly LocalPluginResult[],
  extra: Partial<MarketplaceValidateReportInput> = {},
): Record<string, unknown> {
  return buildMarketplaceValidateReport({
    root: '/mp-nc',
    marketplace: { name: 'mp', pluginEntries: entries, localPluginSources: [...local] },
    pluginResults: results,
    undeclared: [],
    issues: [],
    duration: '3ms',
    ...extra,
  });
}

/** The refusal a verbose report carries, if any. */
function refusalIn(data: Record<string, unknown>): { message: string } | undefined {
  const issues = data['issues'] as Array<{ code: string; message: string }>;
  return issues.find((issue) => issue.code === RUN_INTEGRITY_CODE);
}

describe('marketplace validate — a declared local plugin the run did not validate', () => {
  it('refuses with ONE RESOURCE_CHECK_BROKEN at error when none of the declared plugins resolved', () => {
    // 🔑 The original defect. Delete the guard and this reds: no issue was
    // collected, so the document reads `status: success` beside nothing that
    // says two plugins went unlooked-at.
    const data = reportFor([ALPHA, BETA], 2, []);

    expect(data['status']).toBe('error');
    expect(data['pluginsValidated']).toBe(0);
    expect(data['issueCounts']).toEqual({ errors: 1, warnings: 0, info: 0 });
    expect(data['issues']).toEqual([
      { unlocated: true, errors: 1, codes: { [RUN_INTEGRITY_CODE]: 1 } },
    ]);
  });

  it('refuses when a DIFFERENT directory was validated in place of the declared one', () => {
    // 🔑 The count-semantics defect. One plugin validated, one declared: by
    // number that is full coverage. By identity `alpha` has no result.
    const stray: LocalPluginSource = { name: 'stray', source: './plugins/stray' };
    const data = reportFor([ALPHA], 1, [validated(stray)], { verbose: true });

    expect(data['status']).toBe('error');
    expect(data['pluginsValidated']).toBe(1);
    expect(refusalIn(data)?.message).toContain('`alpha` (./plugins/alpha)');
    expect(refusalIn(data)?.message).not.toContain('stray');
  });

  it('names every unresolved source and both numbers, and never claims a plugin is broken', () => {
    const data = reportFor([ALPHA, BETA], 3, [], { verbose: true });
    const refusal = refusalIn(data);

    expect(refusal?.message).toContain('declares 2 plugin(s)');
    expect(refusal?.message).toContain('validated 0');
    expect(refusal?.message).toContain('`alpha` (./plugins/alpha)');
    expect(refusal?.message).toContain('`beta` (./plugins/beta)');
    // The RUN is not a verdict — the message never claims a plugin is broken.
    expect(refusal?.message).not.toMatch(/invalid plugin|broken plugin/i);
  });

  it('refuses PARTIAL coverage: declared two, one resolved, the other is named', () => {
    // 🔑 Nothing in the marketplace package checks that a declared local source
    // directory exists, so "declares 2, validated 1" is one plugin silently
    // unvalidated at exit 0 — the same class as zero, one step in.
    const data = reportFor([ALPHA, BETA], 2, [validated(ALPHA)], { verbose: true });

    expect(data['status']).toBe('error');
    expect(data['pluginsValidated']).toBe(1);
    expect(data['issueCounts']).toEqual({ errors: 1, warnings: 0, info: 0 });
    expect(refusalIn(data)?.message).toContain('`beta` (./plugins/beta)');
    expect(refusalIn(data)?.message).not.toContain('`alpha`');
  });

  it('stays green for a marketplace whose entries are all remote', () => {
    // 🔑 The guard against the over-correction the brief warns about: a
    // git/npm-sourced marketplace has nothing local to resolve, and its
    // manifest WAS validated.
    const data = reportFor([], 2, []);

    expect(data['status']).toBe('success');
    expect(data['pluginsValidated']).toBe(0);
    expect(data['issueCounts']).toEqual({ errors: 0, warnings: 0, info: 0 });
    expect(data['issues']).toEqual([]);
  });

  it('stays green for a manifest with no entries at all', () => {
    expect(reportFor([], 0, [])['status']).toBe('success');
  });

  it('stays silent once every declared local plugin was validated, and publishes each by name', () => {
    // 🔑 The positive control: every declared entry has its result, and a real
    // finding is the only way it gates. The row names the entry it satisfies,
    // which is what makes the document's own refusal derivable from it.
    const data = reportFor([ALPHA, BETA], 2, [validated(ALPHA), validated(BETA)]);
    const plugins = data['plugins'] as Array<{ name: string; source: string; path: string }>;

    expect(data['status']).toBe('success');
    expect(data['pluginsValidated']).toBe(2);
    expect(data['issues']).toEqual([]);
    expect(plugins.map((p) => [p.name, p.source, p.path])).toEqual([
      ['alpha', './plugins/alpha', 'plugins/alpha'],
      ['beta', './plugins/beta', 'plugins/beta'],
    ]);
  });

  it('lists an undeclared directory without grading it or failing on it', () => {
    // A `plugins/` dir may hold a directory the manifest does not list. It
    // cannot be installed, so it is not a plugin that went unvalidated; it is
    // published so a reader can see it beside the declared ones.
    const data = reportFor([ALPHA], 1, [validated(ALPHA)], { undeclared: ['plugins/stray'] });

    expect(data['status']).toBe('success');
    expect(data['undeclared']).toEqual(['plugins/stray']);
    expect(data['issues']).toEqual([]);
  });

  it('derives status from the issues it publishes, so a promoted finding gates', () => {
    // The builder owns the status derivation; a caller can no longer hand it
    // a `status` that disagrees with `issues`.
    const data = reportFor([ALPHA], 1, [validated(ALPHA)], {
      issues: [
        { code: 'PLUGIN_MISSING_VERSION', severity: 'error', message: 'no version', location: 'plugins/alpha/.claude-plugin/plugin.json' },
      ],
    });

    expect(data['status']).toBe('error');
    expect(data['issueCounts']).toEqual({ errors: 1, warnings: 0, info: 0 });
    expect(data['summary']).toBe('1 error(s), 0 warning(s), 0 info');
  });

  it('keeps the manifest\'s own summary on the bail path, and no refusal beside it', () => {
    // A manifest that failed to parse carries no sources, so nothing is
    // "expected" — the manifest error is the whole finding, and the refusal
    // must not pile a second report on top of it.
    const data = buildMarketplaceValidateReport({
      root: '/mp-nc',
      marketplace: undefined,
      pluginResults: [],
      undeclared: [],
      issues: [{ code: 'MARKETPLACE_MISSING_MANIFEST', severity: 'error', message: 'missing' }],
      bailSummary: 'Marketplace manifest missing',
      duration: '2ms',
    });

    expect(data['status']).toBe('error');
    expect(data['summary']).toBe('Marketplace manifest missing');
    expect(data['issueCounts']).toEqual({ errors: 1, warnings: 0, info: 0 });
  });
});
