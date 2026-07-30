/**
 * Unit tests for the DEFAULT (non-`--verbose`) per-asset listings published by
 * `vat resources validate` and `vat claude marketplace validate`.
 *
 * One contract, spelled identically by both commands and by `vat skills
 * validate`: `--verbose` means "show all scanned resources, including those
 * without issues", so the DEFAULT publishes one counts-only row per asset that
 * has something to say, and nothing for an asset that does not.
 *
 * Both builders are pure, so this is all in-memory — no CLI spawn, no file
 * system.
 *
 * What each fixture below is built to DISTINGUISH is stated at its definition.
 * The short version: a fixture where every asset has findings cannot detect the
 * "clean assets are omitted" rule, and a fixture with one issue per asset cannot
 * detect a per-code tally, its ordering, or an omitted zero bucket.
 */

import { describe, expect, it } from 'vitest';

import {
  buildMarketplaceValidateReport,
  createMarketplaceValidateCommand,
  summarizeIssuesByLocation,
} from '../../src/commands/claude/marketplace/validate.js';
import { createResourcesCommand } from '../../src/commands/resources/index.js';
import { buildIssuesOutputData } from '../../src/commands/resources/validate.js';

// ---------------------------------------------------------------------------
// vat resources validate
// ---------------------------------------------------------------------------

/** Registry stub: no resource belongs to a collection, so collection stats stay empty. */
const NO_COLLECTIONS = { getResource: () => undefined };

/**
 * `filesScanned: 3` against a fixture that puts issues on only TWO files.
 *
 * The gap is the whole point: it is what lets a test tell "the clean file was
 * dropped from the listing" apart from "the clean file was never scanned".
 */
const CONTEXT = {
  stats: { totalResources: 3, totalLinks: 9, linksByType: {} },
  validationMetadata: { validationMode: 'strict' as const },
  collectionStats: undefined,
  duration: 21,
};

function resourceIssue(
  file: string,
  code: string,
  severity: 'error' | 'warning' | 'info' | 'ignore',
  line: number,
) {
  return {
    file,
    absPath: `/testroot-dsl/${file}`,
    line,
    column: 1,
    code,
    severity,
    message: `${code} at ${file}:${line}`,
  };
}

/**
 * Two files with findings, out of three scanned.
 *
 * - `docs/a.md` carries TWO issues of one code and ONE of another, at two
 *   different severities. Two counts that differ is the only shape that can
 *   show a tally (rather than a list of codes) AND show its descending order.
 *   Its findings are error+warning only, so a published `info: 0` would be
 *   visible.
 * - `docs/b.md` carries a single info finding, so a published `errors: 0` /
 *   `warnings: 0` would be visible there.
 * - `docs/clean.md` is scanned and emits nothing, so it must not appear.
 */
const RESOURCE_ISSUES = [
  resourceIssue('docs/a.md', 'LINK_BROKEN_FILE', 'error', 4),
  resourceIssue('docs/a.md', 'MALFORMED_HTML', 'warning', 9),
  resourceIssue('docs/a.md', 'LINK_BROKEN_FILE', 'error', 11),
  resourceIssue('docs/b.md', 'LINK_DEFERRED_ARTIFACT', 'info', 2),
];

const resourceReport = (verbose: boolean) =>
  buildIssuesOutputData(RESOURCE_ISSUES, CONTEXT, NO_COLLECTIONS, verbose);

describe('vat resources validate — default per-file listing', () => {
  it('publishes one counts-only row per file with findings, and none for the clean file', () => {
    const data = resourceReport(false);

    expect(data.issues).toEqual([
      { file: 'docs/a.md', errors: 2, warnings: 1, codes: { LINK_BROKEN_FILE: 2, MALFORMED_HTML: 1 } },
      { file: 'docs/b.md', info: 1, codes: { LINK_DEFERRED_ARTIFACT: 1 } },
    ]);
    // The denominator still names every file scanned, including the clean one
    // the listing omits.
    expect(data.filesScanned).toBe(3);
  });

  it('omits zero severity buckets entirely rather than publishing `errors: 0`', () => {
    const [rowA, rowB] = resourceReport(false).issues ?? [];

    expect(Object.keys(rowA ?? {})).toEqual(['file', 'errors', 'warnings', 'codes']);
    expect(Object.keys(rowB ?? {})).toEqual(['file', 'info', 'codes']);
  });

  it('orders each row`s code tally descending by count', () => {
    const [rowA] = resourceReport(false).issues ?? [];

    // Insertion order IS the YAML serialization order, so this is the feature:
    // the dominant code is named first without the reader tallying anything.
    expect(Object.keys((rowA as { codes: Record<string, number> }).codes)).toEqual([
      'LINK_BROKEN_FILE',
      'MALFORMED_HTML',
    ]);
  });

  it('keeps today`s per-issue detail under --verbose', () => {
    const data = resourceReport(true);

    expect(data.issues).toEqual([
      {
        file: 'docs/a.md',
        issues: [
          { line: 4, column: 1, code: 'LINK_BROKEN_FILE', severity: 'error', message: 'LINK_BROKEN_FILE at docs/a.md:4' },
          { line: 9, column: 1, code: 'MALFORMED_HTML', severity: 'warning', message: 'MALFORMED_HTML at docs/a.md:9' },
          { line: 11, column: 1, code: 'LINK_BROKEN_FILE', severity: 'error', message: 'LINK_BROKEN_FILE at docs/a.md:11' },
        ],
      },
      {
        file: 'docs/b.md',
        issues: [
          { line: 2, column: 1, code: 'LINK_DEFERRED_ARTIFACT', severity: 'info', message: 'LINK_DEFERRED_ARTIFACT at docs/b.md:2' },
        ],
      },
    ]);
  });

  it('publishes byte-identical top-level totals in both modes', () => {
    // The listing is a projection; every consumer-facing total beside it is a
    // fact about the run and must not move when the projection changes.
    const summary = resourceReport(false);
    const verbose = resourceReport(true);

    for (const key of [
      'status',
      'filesScanned',
      'filesWithErrors',
      'errorsFound',
      'issueCounts',
      'issueSummary',
      'validationMode',
      'durationSecs',
    ] as const) {
      expect({ [key]: summary[key] }).toEqual({ [key]: verbose[key] });
    }
    expect(summary.issueSummary).toEqual({
      LINK_BROKEN_FILE: 2,
      MALFORMED_HTML: 1,
      LINK_DEFERRED_ARTIFACT: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// vat claude marketplace validate
// ---------------------------------------------------------------------------

function marketplaceIssue(
  location: string | undefined,
  code: string,
  severity: 'error' | 'warning' | 'info',
) {
  return {
    severity,
    code,
    message: `${code} at ${location ?? '<none>'}`,
    ...(location === undefined ? {} : { location }),
  };
}

/**
 * Three assets' worth of findings, keyed by `location`.
 *
 * - `plugins/alpha/.claude-plugin/plugin.json` gets two findings of one code and
 *   one of another — the only shape that can show a tally and its order.
 * - `plugins/beta/skills/x/SKILL.md` gets a single info finding, so a published
 *   `errors: 0` would be visible.
 * - One finding carries NO location at all. Grouping by `location` is exactly
 *   the operation that can silently drop it, and dropping it is the reassuring
 *   failure (a smaller summary), so it gets its own row and its own assertion —
 *   a row that must NOT invent a `location`, because every `location` in this
 *   document has to resolve under the stated `root`.
 */
const ALPHA = 'plugins/alpha/.claude-plugin/plugin.json';
const BETA = 'plugins/beta/skills/x/SKILL.md';

const MARKETPLACE_ISSUES = [
  marketplaceIssue(ALPHA, 'PLUGIN_MISSING_VERSION', 'error'),
  marketplaceIssue(BETA, 'SKILL_DESCRIPTION_SHORT', 'info'),
  marketplaceIssue(ALPHA, 'PLUGIN_MISSING_VERSION', 'error'),
  marketplaceIssue(ALPHA, 'PLUGIN_MISSING_AUTHOR', 'warning'),
  marketplaceIssue(undefined, 'MARKETPLACE_MISSING_LICENSE', 'error'),
];

const MARKETPLACE_INPUT = {
  status: 'error' as const,
  root: '/testroot-dsl/mp',
  marketplace: { name: 'mp', version: '1.0.0' },
  pluginResults: [],
  issues: MARKETPLACE_ISSUES,
  issueCounts: { errors: 3, warnings: 1, info: 1 },
  summary: '3 error(s), 1 warning(s), 1 info',
  duration: '7ms',
};

const marketplaceReport = (verbose: boolean) =>
  buildMarketplaceValidateReport({ ...MARKETPLACE_INPUT, verbose });

describe('vat claude marketplace validate — default per-location listing', () => {
  it('publishes one counts-only row per location, in first-seen order', () => {
    expect(marketplaceReport(false)['issues']).toEqual([
      {
        location: ALPHA,
        errors: 2,
        warnings: 1,
        codes: { PLUGIN_MISSING_VERSION: 2, PLUGIN_MISSING_AUTHOR: 1 },
      },
      { location: BETA, info: 1, codes: { SKILL_DESCRIPTION_SHORT: 1 } },
      { unlocated: true, errors: 1, codes: { MARKETPLACE_MISSING_LICENSE: 1 } },
    ]);
  });

  it('does not drop a finding that carries no location', () => {
    const rows = marketplaceReport(false)['issues'] as Array<{ errors?: number }>;
    const total = rows.reduce((sum, row) => sum + (row.errors ?? 0), 0);

    expect(total).toBe(MARKETPLACE_INPUT.issueCounts.errors);
  });

  it('never invents a `location` for a finding that had none', () => {
    // Every `location` in this document must satisfy the anchor contract —
    // `join(root, location)` names a real file — so a sentinel string like
    // `(no location)` would be a path resolving to nothing, exactly the
    // coordinate lie the stated `root` exists to prevent. Asserted separately
    // from the row shape above because a future refactor could restore the
    // sentinel while every count still reconciled.
    const rows = marketplaceReport(false)['issues'] as Array<{ location?: string }>;

    expect(rows.filter((row) => row.location === undefined)).toHaveLength(1);
    expect(rows.map((row) => row.location).filter((l) => l !== undefined)).toEqual([ALPHA, BETA]);
  });

  it('omits zero severity buckets entirely rather than publishing `warnings: 0`', () => {
    const rows = marketplaceReport(false)['issues'] as Array<Record<string, unknown>>;

    expect(Object.keys(rows[1] ?? {})).toEqual(['location', 'info', 'codes']);
  });

  it('keeps the flat per-issue list under --verbose', () => {
    expect(marketplaceReport(true)['issues']).toEqual(MARKETPLACE_ISSUES);
  });

  it('publishes byte-identical root, marketplace, counts, summary and duration in both modes', () => {
    const summary = marketplaceReport(false);
    const verbose = marketplaceReport(true);

    for (const key of ['root', 'marketplace', 'plugins', 'issueCounts', 'summary', 'duration']) {
      expect({ [key]: summary[key] }).toEqual({ [key]: verbose[key] });
    }
    // `root` is the document's declared coordinate system; every `location` in
    // the listing stays relative to it, un-rebased.
    expect(summary['root']).toBe(MARKETPLACE_INPUT.root);
  });
});

describe('summarizeIssuesByLocation', () => {
  it('returns an empty listing for an empty issue set', () => {
    expect(summarizeIssuesByLocation([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The property that keeps `vat verify --verbose` from becoming a system-error
// ---------------------------------------------------------------------------

/**
 * `vat verify` forwards `--verbose` to each of its subprocess phases. Commander
 * exits with an "unknown option" error on a flag a command does not declare, so
 * a phase that has not declared it does not merely ignore the flag — it FAILS,
 * turning a verbosity preference into a `system-error` phase result.
 *
 * `parseOptions` answers exactly that question (would Commander reject this
 * argv?) without running the action, so this is a real parse rather than a
 * reading of the declaration.
 */
describe('--verbose is accepted by every phase vat verify forwards it to', () => {
  const resourcesValidate = createResourcesCommand()
    .commands.find((c) => c.name() === 'validate');

  it.each([
    ['vat resources validate', () => resourcesValidate],
    ['vat claude marketplace validate', () => createMarketplaceValidateCommand()],
  ])('%s accepts both spellings of the flag', (_name, make) => {
    const command = make();
    expect(command).toBeDefined();

    // Spelled `-v, --verbose` on both, matching `vat skills validate` — the
    // short form is half the contract, and a command declaring only `--verbose`
    // would still reject `-v`.
    expect(command?.parseOptions(['--verbose']).unknown).toEqual([]);
    expect(command?.parseOptions(['-v']).unknown).toEqual([]);
  });
});
