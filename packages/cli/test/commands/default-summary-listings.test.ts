/**
 * Unit tests for the DEFAULT (non-`--verbose`) per-asset listings published by
 * `vat resources validate` and `vat claude marketplace validate`.
 *
 * One contract: `--verbose` means "show all scanned resources, including those
 * without issues". `vat resources validate` publishes the report envelope, so
 * its findings are always flat and `--verbose` adds one `data.files` row per
 * resource validated. `vat claude marketplace validate` publishes the envelope
 * too: every finding flat, whatever the verbosity — `--verbose` there decides
 * only how much stderr prints.
 *
 * Both builders are pure, so this is all in-memory — no CLI spawn, no file
 * system.
 *
 * What each fixture below is built to DISTINGUISH is stated at its definition.
 * The short version: a fixture where every asset has findings cannot detect the
 * "clean assets are omitted" rule, and a fixture with one issue per asset cannot
 * detect a per-code tally, its ordering, or an omitted zero bucket.
 */

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import {
  buildMarketplaceValidateReport,
  createMarketplaceValidateCommand,
} from '../../src/commands/claude/marketplace/validate.js';
import { createResourcesCommand } from '../../src/commands/resources/index.js';
import { buildResourcesValidateReport } from '../../src/commands/resources/validate.js';

// ---------------------------------------------------------------------------
// vat resources validate
// ---------------------------------------------------------------------------

/**
 * Three resources validated against a fixture that puts issues on only TWO.
 *
 * The gap is the whole point: it is what lets a test tell "the clean file was
 * dropped from the listing" apart from "the clean file was never validated".
 */
const RESOURCE_ROOT = safePath.resolve('/testroot-dsl');
const RESOURCES = ['docs/a.md', 'docs/b.md', 'docs/clean.md'].map((file) => ({ filePath: safePath.join(RESOURCE_ROOT, file) }));

function resourceIssue(location: string, code: string, severity: 'error' | 'warning' | 'info' | 'ignore', line: number) {
  return { location, line, code, severity, message: `${code} at ${location}:${line}` };
}

/**
 * - `docs/a.md` carries three findings at two severities.
 * - `docs/b.md` carries a single info finding.
 * - `docs/clean.md` is validated and emits nothing.
 */
const RESOURCE_ISSUES = [
  resourceIssue('docs/a.md', 'LINK_BROKEN_FILE', 'error', 4),
  resourceIssue('docs/a.md', 'MALFORMED_HTML', 'warning', 9),
  resourceIssue('docs/a.md', 'LINK_BROKEN_FILE', 'error', 11),
  resourceIssue('docs/b.md', 'LINK_DEFERRED_ARTIFACT', 'info', 2),
];

const resourceReport = (verbose: boolean) =>
  buildResourcesValidateReport({
    root: RESOURCE_ROOT,
    resources: RESOURCES,
    issues: RESOURCE_ISSUES as Parameters<typeof buildResourcesValidateReport>[0]['issues'],
    collectionStats: undefined,
    verbose,
    durationMs: 21,
  });

describe('vat resources validate — the default listing and --verbose', () => {
  it('publishes every finding flat by default, and no per-file rows', () => {
    const report = resourceReport(false);

    expect(report.findings.map((finding) => `${finding.location ?? ''}:${finding.line ?? ''}`)).toEqual([
      'docs/a.md:4',
      'docs/a.md:9',
      'docs/a.md:11',
      'docs/b.md:2',
    ]);
    expect(report.data).not.toHaveProperty('files');
    // The denominator still names every file validated, including the clean one.
    expect(report.examined).toBe(3);
  });

  it('lists every resource under --verbose, the clean one included', () => {
    expect(resourceReport(true).data.files?.map((row) => [row.path, row.status])).toEqual([
      ['docs/a.md', 'findings'],
      ['docs/b.md', 'findings'],
      ['docs/clean.md', 'ok'],
    ]);
  });

  it('publishes an identical envelope in both modes', () => {
    // `--verbose` adds rows to `data`; every fact about the run is the same.
    const summary = { ...resourceReport(false), data: null };
    const verbose = { ...resourceReport(true), data: null };

    expect(summary).toEqual(verbose);
    expect(summary.summary).toEqual({ errors: 2, warnings: 1, info: 1 });
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
  root: '/testroot-dsl/mp',
  marketplace: { name: 'mp', version: '1.0.0' },
  pluginResults: [],
  undeclared: [],
  refused: [],
  issues: MARKETPLACE_ISSUES,
  durationMs: 7,
};

describe('vat claude marketplace validate — every finding, flat', () => {
  it('publishes every finding once, in producer order, with its own location', () => {
    const report = buildMarketplaceValidateReport(MARKETPLACE_INPUT);

    expect(report.findings.map((finding) => [finding.location, finding.code])).toEqual(
      MARKETPLACE_ISSUES.map((issue) => [issue.location, issue.code]),
    );
    expect(report.summary).toEqual({ errors: 3, warnings: 1, info: 1 });
  });

  it('keeps a finding that carries no location, and never invents one for it', () => {
    // Every `location` in this document must satisfy the anchor contract —
    // `join(root, location)` names a real file — so a sentinel string like
    // `(no location)` would be a path resolving to nothing, exactly the
    // coordinate lie the stated `root` exists to prevent. Grouping by location
    // is the operation that used to lose such a finding.
    const unlocated = buildMarketplaceValidateReport(MARKETPLACE_INPUT).findings.filter((finding) => finding.location === undefined);

    expect(unlocated.map((finding) => finding.code)).toEqual(['MARKETPLACE_MISSING_LICENSE']);
    expect('location' in (unlocated[0] ?? {})).toBe(false);
  });

  it('states the root once, un-rebased, beside the findings relative to it', () => {
    expect(buildMarketplaceValidateReport(MARKETPLACE_INPUT).data.root).toBe(MARKETPLACE_INPUT.root);
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
