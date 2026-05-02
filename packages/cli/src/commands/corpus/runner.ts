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

import { scan } from '@vibe-agent-toolkit/discovery';
import { safePath } from '@vibe-agent-toolkit/utils';
import * as yaml from 'js-yaml';

import { isGitUrl, parseGitUrl } from '../../utils/git-url.js';
import { createLogger } from '../../utils/logger.js';
import { withClonedRepo } from '../audit/git-url-clone.js';
import { getValidationResults } from '../audit.js';

import type { AuditOutcome, AuditStatus, AuditSummary, PluginRow, ReviewOutcome } from './report.js';
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

function statusFromCounts(errors: number, warnings: number): Extract<AuditStatus, 'success' | 'warning' | 'error'> {
  if (errors > 0) return 'error';
  if (warnings > 0) return 'warning';
  return 'success';
}

function summarizeResults(
  results: { status: string; issues?: { severity: string }[] }[]
): AuditSummary {
  let errors = 0;
  let warnings = 0;
  let info = 0;
  for (const r of results) {
    for (const issue of r.issues ?? []) {
      if (issue.severity === 'error') errors += 1;
      else if (issue.severity === 'warning') warnings += 1;
      else if (issue.severity === 'info') info += 1;
    }
  }
  return { errors, warnings, info, files_scanned: results.length };
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
    const results = await getValidationResults(scanPath, true, {}, logger);
    const summary = summarizeResults(results);
    const status = statusFromCounts(summary.errors, summary.warnings);
    const auditYamlPath = safePath.join(opts.runDir, `${entry.name}-audit.yaml`);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- composed under run dir
    writeFileSync(auditYamlPath, yaml.dump({ results }, { lineWidth: -1 }), 'utf-8');

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

interface SkillReviewSection {
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
  sections: SkillReviewSection[],
  okCount: number
): string {
  const header = `# Skill review: ${entry.name}\n\nReviewed ${okCount} of ${sections.length} skills (${sections.length - okCount} errors).\n`;
  const rendered = sections
    .map((s) => `\n---\n\n## ${s.relativePath}\n\n${s.body}\n`)
    .join('');
  return `${header}${rendered}`;
}

/**
 * Discover every SKILL.md under `scanPath` (recursive, gitignore-aware) and
 * invoke `vat skill review` once per skill directory. Concatenate the
 * outputs into `<name>-review.md` with a section per skill keyed by the
 * skill's path relative to the plugin root.
 *
 * Per-skill subprocess failures become error sections; the aggregate is
 * still written so users can see which skills passed and which failed.
 * Returns `status: 'error'` only when no skills were discovered or every
 * subprocess failed.
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
      error: `No SKILL.md files found under ${scanPath}`,
    };
  }

  const sections: SkillReviewSection[] = [];
  for (const skill of skills) {
    const skillDir = dirname(skill.path);
    sections.push(reviewOneSkill(bin, skillDir, skill.relativePath));
  }

  const okCount = sections.filter((s) => s.ok).length;
  const aggregated = renderAggregatedReview(entry, sections, okCount);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- composed under run dir
  writeFileSync(reviewPath, aggregated, 'utf-8');

  if (okCount === 0) {
    const errors = sections
      .map((s) => `${s.relativePath}: ${s.body.replaceAll('\n', ' ').slice(0, 200)}`)
      .join('; ');
    return {
      status: 'error',
      duration_ms: Date.now() - start,
      error: `All ${sections.length} skill reviews failed. ${errors}`,
      output_path: `${entry.name}-review.md`,
    };
  }

  return {
    status: 'ok',
    duration_ms: Date.now() - start,
    output_path: `${entry.name}-review.md`,
  };
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
  writeFileSync(overlayPath, yaml.dump(overlay, { lineWidth: -1 }), 'utf-8');
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
