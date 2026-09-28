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

import type { ValidationResult } from '@vibe-agent-toolkit/agent-skills';
import { scan } from '@vibe-agent-toolkit/discovery';
import { safePath, toForwardSlash, transientRefusalClause } from '@vibe-agent-toolkit/utils';
import type { DirectoryRefusal } from '@vibe-agent-toolkit/utils/crawl';
import { isGitUrl, parseGitUrl } from '@vibe-agent-toolkit/utils/git';
import * as yaml from 'yaml';

import { writeArtifactFile } from '../../utils/document-writer.js';
import { createLogger } from '../../utils/logger.js';
import { withRunIntegrity } from '../../utils/run-integrity.js';
import { resolveVatBinPath } from '../../utils/vat-bin-path.js';
import { withClonedRepo } from '../audit/git-url-clone.js';
import type { Provenance } from '../audit/provenance.js';
import { AUDIT_EXAMINED } from '../audit-schema.js';
import {
  buildAuditDocument,
  deriveScanRoot,
  getValidationResults,
  urlAuditReport,
  type AuditReport,
  type CompletedAuditReport,
} from '../audit.js';

import type { AuditOutcome, PluginRow, ReviewOutcome, ReviewSummary } from './report.js';
import type { PluginEntry } from './seed.js';

export interface RunnerOptions {
  runDir: string;
  withReview: boolean;
  debug: boolean;
}

const SKIPPED_REVIEW: ReviewOutcome = { status: 'skipped', duration_ms: 0 };

/** Where a cloned source came from, and the tempdir its paths are spelled under. */
interface ClonedSource {
  provenance: Provenance;
  tempRoot: string;
}

/**
 * Derive one plugin's audit row and its document from the per-file results.
 *
 * The document IS the `vat audit` report — the same builder, the same
 * run-integrity pass the writer applies to the verb, the same schema — so a
 * corpus row and the verb cannot disagree about a tree. A source that resolved
 * to a tree with nothing to audit (a wrong subdirectory, a clone whose default
 * branch holds no skill, an excluded tree) examined zero files and carries the
 * one non-overridable `RESOURCE_CHECK_BROKEN`, counted in the row's `errors`
 * and `findings_emitted`, rather than writing the row of a clean plugin.
 *
 * `unloadable` is deliberately NOT the status here. Unloadable means the audit
 * could not run — a missing path, a failed clone. This audit ran, and found no
 * file to run over; the difference is the difference between "no verdict
 * possible" and "this verdict is vacuous", and `computeTotals` counts them
 * apart.
 *
 * Pure, and exported for that reason: the runner's loop clones, writes and
 * catches, and the refusal has to be pinned without any of that.
 *
 * @param results - One validation result per audited file
 * @param durationMs - The row's measured duration
 * @param outputPath - Where the document is written, relative to the run dir
 * @param root - The scan root the document's paths are relative to
 * @param cloned - For a URL source: its provenance and clone dir
 * @returns The row's audit outcome and the document to write for it
 */
export function buildAuditOutcome(
  results: readonly ValidationResult[],
  durationMs: number,
  outputPath: string,
  root: string,
  cloned?: ClonedSource,
): { audit: AuditOutcome; document: AuditReport } {
  const built = buildAuditDocument(results, { root, compatMap: undefined, verbose: false, hierarchical: null, durationMs });
  const located: CompletedAuditReport = cloned === undefined ? built : urlAuditReport(built, cloned.provenance, cloned.tempRoot);
  const document = withRunIntegrity(located, AUDIT_EXAMINED);
  if (document.status === 'error') {
    // `withRunIntegrity` never turns a finished report into an unfinished one.
    throw new Error('buildAuditOutcome: a finished audit report came back as status error');
  }

  return {
    audit: {
      status: document.status,
      duration_ms: durationMs,
      // Two denominators, two keys: `summary` counts FINDINGS, `files_scanned` FILES.
      summary: document.summary,
      files_scanned: document.examined,
      findings_emitted: document.findings.length,
      output_path: outputPath,
    },
    document,
  };
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
      async ({ targetDir, tempdir, provenance }) => auditAndRecord(entry, targetDir, opts, { provenance, tempRoot: tempdir })
    );
  } catch (err) {
    return unloadableRow(entry, err instanceof Error ? err.message : String(err), 0);
  }
}

async function auditAndRecord(
  entry: PluginEntry,
  scanPath: string,
  opts: RunnerOptions,
  cloned?: ClonedSource,
): Promise<PluginRow> {
  const logger = createLogger(opts.debug ? { debug: true } : {});
  const start = Date.now();

  const validationApplied = applyValidationOverlay(entry, scanPath);

  let audit: AuditOutcome;
  try {
    // The corpus run root is the scanned plugin itself — one root per row.
    const root = deriveScanRoot(scanPath);
    const results = await getValidationResults(scanPath, true, {}, logger, root);
    const outputPath = `${entry.name}-audit.yaml`;
    const outcome = buildAuditOutcome(results, Date.now() - start, outputPath, root, cloned);
    writeArtifactFile('corpus-audit', safePath.join(opts.runDir, outputPath), outcome.document);
    audit = outcome.audit;
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
  // The node running this process, never a PATH lookup.
  const result = spawnSync(process.execPath, [bin, 'skill', 'review', skillDir], {
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
 * One failed section per directory the review scan could not list.
 *
 * The review lane's population is what `scan` enumerates; a directory it could
 * not enter is a set of skills that were never reviewed, and a review.md that
 * omits them reads as one that covered the plugin. Filing the gap on the
 * existing per-skill channel — `ok: false`, keyed by the directory — is what
 * makes `buildReviewOutcome` grade the run `error` and the aggregate name the
 * subtree, without inventing a second channel the report would have to learn.
 *
 * @param unreadable - What `ScanSummary.unreadable` carried
 * @param scanPath - The plugin root every section is keyed relative to
 * @returns Sections in the order the refusals were met
 */
export function unlistedDirectorySections(
  unreadable: readonly DirectoryRefusal[],
  scanPath: string,
): SkillReviewSection[] {
  return unreadable.map((refusal) => {
    const relativePath = toForwardSlash(safePath.relative(scanPath, refusal.directory)) || '.';
    const cause = refusal.transient
      ? `${transientRefusalClause(refusal.code)} — re-run before investigating anything`
      : `listing was refused with ${refusal.code}`;
    return {
      relativePath,
      ok: false,
      body: `Directory could not be listed (${cause}); every skill beneath it was not reviewed.`,
    };
  });
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
  // Directories the scan could not list hold skills this review never saw. They
  // enter the aggregate as failed sections — see `unlistedDirectorySections` —
  // so the outcome is `error` and the review names the gap, while every skill
  // that WAS found is still reviewed below.
  const unlisted = unlistedDirectorySections(summary.unreadable, scanPath);

  if (skills.length === 0 && unlisted.length === 0) {
    return {
      status: 'error',
      duration_ms: Date.now() - start,
      summary: summarizeReview([]),
      error: `No SKILL.md files found under ${scanPath}`,
    };
  }

  const sections: SkillReviewSection[] = [...unlisted];
  for (const skill of skills) {
    const skillDir = dirname(skill.path);
    sections.push(reviewOneSkill(bin, skillDir, skill.relativePath));
  }

  const aggregated = renderAggregatedReview(entry, sections, summarizeReview(sections));

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
