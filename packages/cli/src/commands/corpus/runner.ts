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
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ValidationResult } from '@vibe-agent-toolkit/agent-skills';
import { scan } from '@vibe-agent-toolkit/discovery';
import { ExitCode, exitCodeOfChild } from '@vibe-agent-toolkit/schema';
import { fsFaultOf, pathPresent, safePath, suppressedFaultsOf, toForwardSlash, transientRefusalClause } from '@vibe-agent-toolkit/utils';
import type { DirectoryRefusal } from '@vibe-agent-toolkit/utils/crawl';
import { isGitUrl, parseGitUrl } from '@vibe-agent-toolkit/utils/git';
import * as yaml from 'yaml';

import { errorMessageOf, refusalCodeOf } from '../../utils/command-refusal.js';
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

import { writeRunOutput, type AuditOutcome, type PluginRow, type ReviewOutcome, type ReviewSummary } from './report.js';
import type { PluginEntry } from './seed.js';

export interface RunnerOptions {
  runDir: string;
  withReview: boolean;
  debug: boolean;
  /**
   * Where a URL entry's clone the OS would not remove, once its row was done, is put — the
   * classified fault naming it — for the scan to report as a warning. Required: a scan cannot
   * run an entry without saying where its leftover goes.
   */
  leftovers: unknown[];
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
export function auditOnePlugin(
  entry: PluginEntry,
  opts: RunnerOptions
): Promise<PluginRow> {
  try {
    return isGitUrl(entry.source) ? runUrlEntry(entry, opts) : runLocalEntry(entry, opts);
  } catch (error) {
    return Promise.reject(error as Error);
  }
}

function runLocalEntry(entry: PluginEntry, opts: RunnerOptions): Promise<PluginRow> {
  const unusable = localSourceUnusable(entry.source);
  if (unusable !== undefined) return Promise.resolve(unloadableRow(entry, unusable, 0));
  return auditAndRecord(entry, entry.source, opts);
}

/**
 * Why a local source cannot be audited, or `undefined` when it can be.
 *
 * Absent and unreadable are told apart (`pathPresent`, never `existsSync`,
 * which calls an `EACCES` parent "not found"), and both are one entry's
 * outcome — an unloadable row — never the whole scan's: per-plugin failures
 * never abort the loop. `pathPresent` throws only its coded refusal.
 */
function localSourceUnusable(source: string): string | undefined {
  try {
    return pathPresent(source, 'follow', 'source', 'probe') ? undefined : `Source path not found: ${source}`;
  } catch (error) {
    if (!isEntryRefusal(error)) throw error;
    return errorMessageOf(error);
  }
}

/**
 * Whether a thrown value is this ENTRY's outcome (an unloadable row) rather than
 * the scan's. One rule for every catch in the runner, decided by code:
 * - an uncoded throw (`INTERNAL_ERROR`) is a VAT defect, never a property of the
 *   plugin — swallowing it into a warning row would exit 0 over a broken build;
 * - `RUN_INCOMPLETE` is a write under `--out` the OS refused: the RUN's refusal,
 *   the same in both lanes.
 * Every other coded refusal (a failed clone, an unreadable source) is the entry's.
 */
function isEntryRefusal(error: unknown): boolean {
  const code = refusalCodeOf(error);
  return code !== 'INTERNAL_ERROR' && code !== 'RUN_INCOMPLETE';
}

async function runUrlEntry(entry: PluginEntry, opts: RunnerOptions): Promise<PluginRow> {
  try {
    const { value: row, leftover } = await withClonedRepo(
      parseGitUrl(entry.source),
      { keepTempForDebug: opts.debug },
      ({ targetDir, tempdir, provenance }) => auditAndRecord(entry, targetDir, opts, { provenance, tempRoot: tempdir })
    );
    // The row is done: a clone left behind is the scan's warning, never this entry's failure.
    if (leftover !== undefined) opts.leftovers.push(leftover);
    return row;
  } catch (err) {
    if (!isEntryRefusal(err)) throw err;
    // The refusal becomes a row, so a clone recorded beside it would vanish with it: the scan reports it.
    opts.leftovers.push(...suppressedFaultsOf(err));
    return unloadableRow(entry, errorMessageOf(err), 0);
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

  const overlay = applyValidationOverlay(entry, scanPath);
  // The overlay goes into the SOURCE, not --out: a source that refuses it is this
  // entry's unloadable row in both lanes, and the scan carries on.
  if (overlay.refused !== undefined) return unloadableRow(entry, overlay.refused, Date.now() - start);
  const validationApplied = overlay.applied;

  const outputPath = `${entry.name}-audit.yaml`;
  let outcome: ReturnType<typeof buildAuditOutcome> | undefined;
  let audit: AuditOutcome;
  try {
    // The corpus run root is the scanned plugin itself — one root per row.
    const root = deriveScanRoot(scanPath);
    const results = await getValidationResults(scanPath, true, {}, logger, root);
    outcome = buildAuditOutcome(results, Date.now() - start, outputPath, root, cloned);
    audit = outcome.audit;
  } catch (err) {
    if (!isEntryRefusal(err)) throw err;
    audit = {
      status: 'unloadable',
      duration_ms: Date.now() - start,
      error: errorMessageOf(err),
    };
  }
  // Outside the catch: a document the audit produced and the OS would not let
  // the scan write is the RUN's refusal, not an unloadable plugin.
  if (outcome !== undefined) {
    const auditPath = safePath.join(opts.runDir, outputPath);
    const { document } = outcome;
    writeRunOutput(auditPath, () => writeArtifactFile('corpus-audit', auditPath, document));
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

  // Findings (exit 1) are still a review that ran; only ERROR — or a status off the
  // contract, which `exitCodeOfChild` reads as ERROR — means it did not finish.
  const reviewRan = exitCodeOfChild(result.status) !== ExitCode.ERROR;

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

  writeRunOutput(reviewPath, () => writeFileSync(reviewPath, aggregated, 'utf-8'));

  return buildReviewOutcome(sections, `${entry.name}-review.md`, Date.now() - start);
}

/** Whether the overlay was written, or why the source refused it. */
type OverlayOutcome = { applied: boolean; refused?: undefined } | { applied: false; refused: string };

/**
 * Write a synthetic `vibe-agent-toolkit.config.yaml` at the audit target,
 * placing the entry's `validation:` block under `skills.defaults.validation`.
 *
 * A write the OS refuses (classified by errno) is the SOURCE's — the entry's
 * outcome, not the run's; anything else propagates as a defect.
 *
 * Phase 1: clobbers any pre-existing config in the cloned tree. Merging
 * with author-shipped configs is a follow-up.
 */
function applyValidationOverlay(entry: PluginEntry, scanPath: string): OverlayOutcome {
  if (!entry.validation) return { applied: false };

  const overlayPath = safePath.join(scanPath, 'vibe-agent-toolkit.config.yaml');
  const overlay = {
    skills: {
      defaults: {
        validation: entry.validation,
      },
    },
  };
  try {
    writeFileSync(overlayPath, yaml.stringify(overlay, { lineWidth: 0, aliasDuplicateObjects: false }), 'utf-8');
  } catch (error) {
    if (fsFaultOf(error) === undefined) throw error;
    return { applied: false, refused: `Could not write the validation overlay ${overlayPath}: ${errorMessageOf(error)}` };
  }
  return { applied: true };
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
