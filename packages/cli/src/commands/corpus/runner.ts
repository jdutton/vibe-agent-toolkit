/**
 * Per-plugin orchestrator for `vat corpus scan`.
 *
 * Phase 1 scope: resolve source (local or URL), optionally overlay a
 * synthetic `vibe-agent-toolkit.config.yaml` from the entry's `validation:`
 * block, run `vat audit` in-process, optionally invoke `vat skill review`,
 * write per-plugin sibling files into the run directory, and return a
 * PluginRow. Per-plugin failures never abort the loop.
 *
 * URL handling clones via Layer 1's `withClonedRepo` helper. Validation
 * overlay (Task 5) is added on top of this base.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { calculateValidationStatus, countBySeverity, type ValidationIssue } from '@vibe-agent-toolkit/agent-schema';
import { scan } from '@vibe-agent-toolkit/discovery';
import { isGitUrl, parseGitUrl, safePath } from '@vibe-agent-toolkit/utils';
import * as yaml from 'yaml';

import { createLogger } from '../../utils/logger.js';
import { withClonedRepo } from '../audit/git-url-clone.js';
import { deriveScanRoot, getValidationResults } from '../audit.js';

import type { AuditOutcome, AuditSummary, PluginRow, ReviewOutcome, ReviewSummary } from './report.js';
import type { PluginEntry } from './seed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the path to the built vat CLI entry. Works whether the runner is
 * invoked from compiled dist (production) or from source under vitest. In
 * either case we always invoke the *compiled* `dist/bin.js` — `node` cannot
 * execute `.ts` directly, so the source-tree fallback walks across to
 * `packages/cli/dist/bin.js`. A build is therefore required before tests that
 * exercise the review path can pass.
 */
function resolveVatBinPath(): string {
  // Compiled tree: packages/cli/dist/commands/corpus/runner.js → packages/cli/dist/bin.js
  const compiled = safePath.resolve(__dirname, '../../bin.js');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- internal path
  if (existsSync(compiled)) return compiled;
  // Source tree (vitest): packages/cli/src/commands/corpus/runner.ts → packages/cli/dist/bin.js
  return safePath.resolve(__dirname, '../../../dist/bin.js');
}

export interface RunnerOptions {
  runDir: string;
  withReview: boolean;
  debug: boolean;
}

const SKIPPED_REVIEW: ReviewOutcome = { status: 'skipped', duration_ms: 0 };

/**
 * Roll a run's per-file results up into one corpus row.
 *
 * `files_scanned` counts FILES; the severity buckets count FINDINGS — two
 * different denominators, so they are named differently on purpose.
 */
function summarizeRun(allIssues: readonly ValidationIssue[], filesScanned: number): AuditSummary {
  return { ...countBySeverity(allIssues), files_scanned: filesScanned };
}

/**
 * Run audit + optional review against one plugin entry.
 */
export async function auditOnePlugin(
  entry: PluginEntry,
  opts: RunnerOptions
): Promise<PluginRow> {
  if (isGitUrl(entry.source)) {
    return runUrlEntry(entry, opts);
  }
  return runLocalEntry(entry, opts);
}

async function runLocalEntry(entry: PluginEntry, opts: RunnerOptions): Promise<PluginRow> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-supplied seed entry
  if (!existsSync(entry.source)) {
    return unloadableRow(entry, `Source path not found: ${entry.source}`, 0);
  }
  return auditAndRecord(entry, entry.source, opts);
}

async function runUrlEntry(entry: PluginEntry, opts: RunnerOptions): Promise<PluginRow> {
  try {
    return await withClonedRepo(
      parseGitUrl(entry.source),
      { keepTempForDebug: opts.debug },
      async ({ targetDir }) => auditAndRecord(entry, targetDir, opts)
    );
  } catch (err) {
    return unloadableRow(entry, err instanceof Error ? err.message : String(err), 0);
  }
}

async function auditAndRecord(
  entry: PluginEntry,
  scanPath: string,
  opts: RunnerOptions
): Promise<PluginRow> {
  const logger = createLogger(opts.debug ? { debug: true } : {});
  const start = Date.now();

  const validationApplied = applyValidationOverlay(entry, scanPath);

  let audit: AuditOutcome;
  try {
    // The corpus run root is the scanned plugin itself — one root per row.
    const results = await getValidationResults(scanPath, true, {}, logger, deriveScanRoot(scanPath));
    const allIssues = results.flatMap(r => r.issues);
    const summary = summarizeRun(allIssues, results.length);
    const status = calculateValidationStatus(allIssues);
    const auditYamlPath = safePath.join(opts.runDir, `${entry.name}-audit.yaml`);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- composed under run dir
    writeFileSync(auditYamlPath, yaml.stringify({ results }, { lineWidth: 0, aliasDuplicateObjects: false }), 'utf-8');

    audit = {
      status,
      duration_ms: Date.now() - start,
      summary,
      findings_emitted: summary.errors + summary.warnings + summary.info,
      output_path: `${entry.name}-audit.yaml`,
    };
  } catch (err) {
    audit = {
      status: 'unloadable',
      duration_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Skip review when audit was unloadable — nothing meaningful to review.
  const review =
    opts.withReview && audit.status !== 'unloadable'
      ? await runSkillReview(entry, scanPath, opts.runDir)
      : SKIPPED_REVIEW;

  return {
    source: entry.source,
    name: entry.name,
    validation_applied: validationApplied,
    audit,
    review,
  };
}

export interface SkillReviewSection {
  relativePath: string;
  ok: boolean;
  body: string;
}

/**
 * Spawn `vat skill review <skillDir>` for one skill and return a markdown
 * section describing the result. Subprocess failure is captured as an
 * error section rather than thrown — one bad skill must not abort siblings.
 */
function reviewOneSkill(bin: string, skillDir: string, relativePath: string): SkillReviewSection {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- node is required for invoking vat
  const result = spawnSync('node', [bin, 'skill', 'review', skillDir], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // `vat skill review` exit semantics:
  //   0 — review clean
  //   1 — review completed but found warnings/errors (still a successful review for corpus purposes)
  //   2 (or other non-zero / null) — system error, the review did not run to completion
  const SKILL_REVIEW_FINDINGS_EXIT = 1;
  const reviewRan = result.status === 0 || result.status === SKILL_REVIEW_FINDINGS_EXIT;

  if (!reviewRan) {
    const stderr = (result.stderr ?? '').trim();
    const message = stderr || `vat skill review exited with code ${result.status ?? 'unknown'}`;
    const stdout = (result.stdout ?? '').trim();
    const stdoutBlock = stdout ? `\n\n${stdout}` : '';
    const body = `**[review failed]**\n\n${message}${stdoutBlock}`;
    return { relativePath, ok: false, body };
  }

  const body = ((result.stdout ?? '') + (result.stderr ?? '')).trim();
  return { relativePath, ok: true, body };
}

function renderAggregatedReview(
  entry: PluginEntry,
  sections: readonly SkillReviewSection[],
  summary: ReviewSummary
): string {
  const header = `# Skill review: ${entry.name}\n\nReviewed ${summary.reviewed} of ${summary.skills_scanned} skills (${summary.failed} errors).\n`;
  const rendered = sections
    .map((s) => `\n---\n\n## ${s.relativePath}\n\n${s.body}\n`)
    .join('');
  return `${header}${rendered}`;
}

/**
 * Bucket the per-skill sections into the outcome distribution carried on the row.
 */
function summarizeReview(sections: readonly SkillReviewSection[]): ReviewSummary {
  const reviewed = sections.filter((s) => s.ok).length;
  return { reviewed, failed: sections.length - reviewed, skills_scanned: sections.length };
}

/**
 * Derive one plugin's `ReviewOutcome` from its per-skill sections.
 *
 * `status: 'ok'` requires `failed === 0` — every discovered skill reviewed to
 * completion. A partially-failed run reports `error`, matching how the audit
 * lane derives its status (any error finding demotes the whole row): a status
 * must never claim more success than the counts behind it support. The counts
 * stay on `summary` so consumers can tell 9-of-10-failed from all-failed.
 */
export function buildReviewOutcome(
  sections: readonly SkillReviewSection[],
  outputPath: string,
  durationMs: number
): ReviewOutcome {
  const summary = summarizeReview(sections);

  if (summary.failed === 0) {
    return { status: 'ok', duration_ms: durationMs, summary, output_path: outputPath };
  }

  const errors = sections
    .filter((s) => !s.ok)
    .map((s) => `${s.relativePath}: ${s.body.replaceAll('\n', ' ').slice(0, 200)}`)
    .join('; ');

  return {
    status: 'error',
    duration_ms: durationMs,
    summary,
    error: `${summary.failed} of ${summary.skills_scanned} skill reviews failed. ${errors}`,
    output_path: outputPath,
  };
}

/**
 * Discover every SKILL.md under `scanPath` (recursive, gitignore-aware) and
 * invoke `vat skill review` once per skill directory. Concatenate the
 * outputs into `<name>-review.md` with a section per skill keyed by the
 * skill's path relative to the plugin root.
 *
 * Per-skill subprocess failures become error sections; the aggregate is
 * still written so users can see which skills passed and which failed.
 * Returns `status: 'error'` when no skills were discovered or ANY subprocess
 * failed — see `buildReviewOutcome`.
 */
async function runSkillReview(
  entry: PluginEntry,
  scanPath: string,
  runDir: string
): Promise<ReviewOutcome> {
  const start = Date.now();
  const bin = resolveVatBinPath();
  const reviewPath = safePath.join(runDir, `${entry.name}-review.md`);

  const summary = await scan({ path: scanPath, recursive: true });
  const skills = summary.results.filter(
    (r) => r.format === 'agent-skill' && !r.isGitIgnored
  );

  if (skills.length === 0) {
    return {
      status: 'error',
      duration_ms: Date.now() - start,
      summary: summarizeReview([]),
      error: `No SKILL.md files found under ${scanPath}`,
    };
  }

  const sections: SkillReviewSection[] = [];
  for (const skill of skills) {
    const skillDir = dirname(skill.path);
    sections.push(reviewOneSkill(bin, skillDir, skill.relativePath));
  }

  const aggregated = renderAggregatedReview(entry, sections, summarizeReview(sections));

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- composed under run dir
  writeFileSync(reviewPath, aggregated, 'utf-8');

  return buildReviewOutcome(sections, `${entry.name}-review.md`, Date.now() - start);
}

/**
 * Write a synthetic `vibe-agent-toolkit.config.yaml` at the audit target,
 * placing the entry's `validation:` block under `skills.defaults.validation`.
 * Returns true iff the overlay was written.
 *
 * Phase 1: clobbers any pre-existing config in the cloned tree. Merging
 * with author-shipped configs is a follow-up.
 */
function applyValidationOverlay(entry: PluginEntry, scanPath: string): boolean {
  if (!entry.validation) return false;

  const overlayPath = safePath.join(scanPath, 'vibe-agent-toolkit.config.yaml');
  const overlay = {
    skills: {
      defaults: {
        validation: entry.validation,
      },
    },
  };
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- composed under audit target
  writeFileSync(overlayPath, yaml.stringify(overlay, { lineWidth: 0, aliasDuplicateObjects: false }), 'utf-8');
  return true;
}

function unloadableRow(entry: PluginEntry, error: string, durationMs: number): PluginRow {
  return {
    source: entry.source,
    name: entry.name,
    validation_applied: false,
    audit: { status: 'unloadable', duration_ms: durationMs, error },
    review: SKIPPED_REVIEW,
  };
}
