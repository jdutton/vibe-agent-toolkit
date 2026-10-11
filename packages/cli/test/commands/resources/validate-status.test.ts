/**
 * Unit tests for the report `vat resources validate` publishes.
 *
 * One question — "issues → status" — gets ONE answer across every report verb,
 * in the envelope's vocabulary: `ok` (nothing found) | `findings` (at least
 * one). The load-bearing case is info-only: it is `findings`, and `summary`
 * says the one thing found was info — the gate (not the status word) is what
 * decides it does not fail the run.
 *
 * The run-integrity refusal for a run over zero resources is the WRITER's, from
 * the registry's declared denominator; the last suite asserts it through
 * `publishedReport`, the one pass every published document takes.
 *
 * All in-memory — the builder is pure, so no CLI spawn and no file system.
 */

import { exitCodeForReport, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { RESOURCES_VALIDATE_REPORT_SCHEMA } from '../../../src/commands/resources/validate-schema.js';
import {
  buildResourcesValidateReport,
  type ResourcesValidateInput,
} from '../../../src/commands/resources/validate.js';
import { publishedReport } from '../../../src/utils/document-writer.js';

/** The code the run-integrity refusal carries, shared with `vat resources check`. */
const RUN_INTEGRITY_CODE = 'RESOURCE_CHECK_BROKEN';

const ROOT = safePath.resolve('/testroot-rv');

/** Three resources, so a report over some of them cannot pass for one over all. */
const RESOURCES = ['docs/a.md', 'docs/b.md', 'docs/c.md'].map((file) => ({ filePath: safePath.join(ROOT, file) }));

/** One library issue at the given severity, all four severities available. */
function issue(severity: ValidationIssue['severity'], location = 'docs/a.md'): ValidationIssue {
  return { code: 'LINK_BROKEN_FILE', severity, message: `${severity} finding`, location, line: 4 };
}

/** The report for a set of issues over {@link RESOURCES}, parsed with the published schema. */
function report(issues: readonly ValidationIssue[], overrides: Partial<ResourcesValidateInput> = {}) {
  const built = buildResourcesValidateReport({
    root: ROOT,
    resources: RESOURCES,
    issues,
    collectionStats: undefined,
    verbose: false,
    durationMs: 12,
    ...overrides,
  });
  RESOURCES_VALIDATE_REPORT_SCHEMA.parse(built);
  return built;
}

const severities = (...list: Array<ValidationIssue['severity']>) => list.map((s) => issue(s));

describe('buildResourcesValidateReport — the envelope vocabulary', () => {
  it('is findings, exit 1, when an error-severity issue fired', () => {
    const built = report(severities('error'));

    expect(built.status).toBe('findings');
    expect(built.summary).toEqual({ errors: 1, warnings: 0, info: 0 });
    expect(exitCodeForReport(built)).toBe(1);
  });

  it('is findings at exit 0 for a warning-only run — the gate is not strict', () => {
    const built = report(severities('warning'));

    expect(built.status).toBe('findings');
    expect(built.gate).toEqual({ strict: false });
    expect(exitCodeForReport(built)).toBe(0);
  });

  it('is findings for an info-only run, with summary naming what was found', () => {
    // The discriminating case: the old vocabulary answered `success` here and
    // left `issueCounts` to say otherwise — two answers to one question.
    const built = report(severities('info'));

    expect(built.status).toBe('findings');
    expect(built.summary.info).toBe(1);
    expect(exitCodeForReport(built)).toBe(0);
  });

  it('publishes an `ignore`-severity issue nowhere — not as a finding, not in summary', () => {
    // Suppressed by the adopter's own `validation.allow` config; publishing it
    // under any other name would resurrect what they deliberately silenced.
    const built = report(severities('ignore'));

    expect(built.status).toBe('ok');
    expect(built.findings).toEqual([]);
    expect(built.summary).toEqual({ errors: 0, warnings: 0, info: 0 });
  });

  it('publishes each finding flat, located relative to the stated root', () => {
    const built = report([issue('error', 'docs/b.md')]);

    expect(built.data.root).toBe(ROOT);
    expect(built.findings).toEqual([
      { code: 'LINK_BROKEN_FILE', severity: 'error', message: 'error finding', location: 'docs/b.md', line: 4 },
    ]);
  });

  it('counts the resources validated as examined', () => {
    expect(report([]).examined).toBe(3);
    expect(report([], { resources: RESOURCES.slice(0, 1) }).examined).toBe(1);
  });
});

describe('the --verbose file rows', () => {
  it('lists every resource validated, the clean ones included, with its own status and summary', () => {
    const built = report([issue('error', 'docs/a.md'), issue('info', 'docs/a.md')], { verbose: true });

    expect(built.data.files).toEqual([
      { path: 'docs/a.md', status: 'findings', summary: { errors: 1, warnings: 0, info: 1 } },
      { path: 'docs/b.md', status: 'ok', summary: { errors: 0, warnings: 0, info: 0 } },
      { path: 'docs/c.md', status: 'ok', summary: { errors: 0, warnings: 0, info: 0 } },
    ]);
  });

  it('publishes no file rows without --verbose, and the same envelope either way', () => {
    const issues = [issue('error', 'docs/a.md')];
    const terse = report(issues);
    const verbose = report(issues, { verbose: true });

    expect(terse.data).not.toHaveProperty('files');
    expect({ ...terse, data: null }).toEqual({ ...verbose, data: null });
  });
});

describe('collections', () => {
  it('counts each collection\'s findings, and its files carrying an error', () => {
    const built = report([issue('error', 'docs/a.md'), issue('warning', 'docs/b.md'), issue('error', 'docs/c.md')], {
      resources: [
        { filePath: safePath.join(ROOT, 'docs/a.md'), collections: ['guides'] },
        { filePath: safePath.join(ROOT, 'docs/b.md'), collections: ['guides'] },
        { filePath: safePath.join(ROOT, 'docs/c.md'), collections: ['other'] },
      ],
      collectionStats: {
        totalCollections: 2,
        resourcesInCollections: 3,
        collections: {
          guides: { resourceCount: 2, hasSchema: false },
          other: { resourceCount: 1, hasSchema: true, validationMode: 'permissive' },
        },
      },
    });

    expect(built.data.collections).toEqual({
      guides: { resourceCount: 2, hasSchema: false, filesWithErrors: 1, summary: { errors: 1, warnings: 1, info: 0 } },
      other: {
        resourceCount: 1,
        hasSchema: true,
        validationMode: 'permissive',
        filesWithErrors: 1,
        summary: { errors: 1, warnings: 0, info: 0 },
      },
    });
  });

  it('publishes `{}` for a project that configures none', () => {
    expect(report([]).data.collections).toEqual({});
  });
});

/**
 * A run that validated NO resource is not a verdict.
 *
 * `vat resources validate --collection no-such-collection` once reported
 * `status: success`, `filesScanned: 0`, exit 0. The refusal is now the
 * writer's, derived from the registry's declared denominator — so the verb has
 * no seam at which to forget it.
 */
describe('a run over zero resources, as published', () => {
  it('is refused with ONE RESOURCE_CHECK_BROKEN at error, exit 1', () => {
    const published = publishedReport('resources validate', report([], { resources: [] }));

    expect(published.status).toBe('findings');
    expect(published.examined).toBe(0);
    expect(published.findings.map((finding) => finding.code)).toEqual([RUN_INTEGRITY_CODE]);
    expect(exitCodeForReport(published)).toBe(1);
  });

  it('says what to check — the --collection filter among the causes — and never that the corpus is broken', () => {
    const [refusal] = publishedReport('resources validate', report([], { resources: [] })).findings;

    expect(refusal?.message).toContain('0 resources');
    expect(refusal?.message).toContain('--collection');
    expect(refusal?.message).toContain('vat resources scan');
    expect(refusal?.message).not.toMatch(/broken link|invalid/i);
  });

  it('stays silent over a populated corpus, however clean', () => {
    const published = publishedReport('resources validate', report([]));

    expect(published.status).toBe('ok');
    expect(published.findings).toEqual([]);
  });
});
