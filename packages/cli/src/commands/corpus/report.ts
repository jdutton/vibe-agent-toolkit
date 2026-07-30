/**
 * Run-summary types + writer for `vat corpus scan`.
 *
 * `summary.yaml` is the index for one scan run. Per-plugin full audit
 * outputs and full skill-review outputs are written as sibling files
 * referenced by relative `output_path`. Totals are derived from the
 * per-plugin rows so callers can pass raw rows and let this module
 * compute aggregates.
 */

import { mkdirSync, writeFileSync } from 'node:fs';

import type { SeverityCounts } from '@vibe-agent-toolkit/agent-schema';
import { safePath } from '@vibe-agent-toolkit/utils';
import * as yaml from 'yaml';

export type AuditStatus = 'success' | 'warning' | 'error' | 'unloadable';
export type ReviewStatus = 'ok' | 'error' | 'skipped';

/**
 * Extends `SeverityCounts` rather than re-declaring `errors`/`warnings`/`info`:
 * `runner.ts` builds this by spreading `countBySeverity()`, so the two are
 * already the same shape by construction. Deriving makes the compiler enforce
 * that, instead of leaving it as a fact someone has to re-verify by hand every
 * time a severity bucket is added.
 */
export interface AuditSummary extends SeverityCounts {
  files_scanned: number;
}

export interface AuditOutcome {
  status: AuditStatus;
  duration_ms: number;
  summary?: AuditSummary;        // present when status != unloadable
  findings_emitted?: number;     // present when status != unloadable
  output_path?: string;          // relative to run dir; absent on unloadable
  error?: string;                // present only on unloadable
}

/**
 * Outcome distribution for one plugin's review lane — the review-side mirror
 * of `AuditSummary`. `skills_scanned` counts SKILLS (the denominator, like
 * `files_scanned`); `reviewed` and `failed` bucket those skills by whether
 * `vat skill review` ran to completion, and always sum to `skills_scanned`.
 */
export interface ReviewSummary {
  reviewed: number;              // review ran to completion (clean or with findings)
  failed: number;                // review did not run to completion
  skills_scanned: number;
}

export interface ReviewOutcome {
  status: ReviewStatus;
  duration_ms: number;
  summary?: ReviewSummary;       // present when the review lane ran (status != skipped)
  output_path?: string;          // present when an aggregated review.md was written
  error?: string;                // present only when status === 'error'
}

export interface PluginRow {
  source: string;
  name: string;
  validation_applied: boolean;
  audit: AuditOutcome;
  review: ReviewOutcome;
}

export interface RunReport {
  schema_version: 1;
  generated_at: string;          // ISO 8601
  vat_version: string;
  vat_commit: string;
  seed_file: string;             // path used at scan invocation
  flags: { with_review: boolean; debug: boolean };
  plugins: PluginRow[];
}

export interface RunTotals {
  plugins: number;
  audit_clean: number;
  audit_warning: number;
  audit_error: number;
  unloadable: number;
  reviewed?: number;             // rows whose review lane ran; present iff flags.with_review
  review_error?: number;         // subset of `reviewed` that failed; present iff flags.with_review
}

/**
 * Compute totals over the per-plugin rows.
 */
export function computeTotals(report: RunReport): RunTotals {
  const totals: RunTotals = {
    plugins: report.plugins.length,
    audit_clean: 0,
    audit_warning: 0,
    audit_error: 0,
    unloadable: 0,
  };

  for (const row of report.plugins) {
    switch (row.audit.status) {
      case 'success': {
        totals.audit_clean += 1;
        break;
      }
      case 'warning': {
        totals.audit_warning += 1;
        break;
      }
      case 'error': {
        totals.audit_error += 1;
        break;
      }
      case 'unloadable': {
        totals.unloadable += 1;
        break;
      }
    }
  }

  if (report.flags.with_review) {
    totals.reviewed = report.plugins.filter((p) => p.review.status !== 'skipped').length;
    totals.review_error = report.plugins.filter((p) => p.review.status === 'error').length;  }

  return totals;
}

/**
 * Build the run directory name: `<YYYY-MM-DD>-<vat-short-sha>`.
 * Date is the UTC date of `generated_at`.
 */
export function runDirectoryName(report: RunReport): string {
  const datePart = report.generated_at.slice(0, 10); // 'YYYY-MM-DD'
  return `${datePart}-${report.vat_commit}`;
}

/**
 * Write `summary.yaml` (and create the run directory) under `outDir`.
 * Returns the absolute path of the created run directory. Per-plugin
 * sibling files (audit outputs, review outputs) are written by the
 * runner — this function only writes the summary index.
 */
export async function writeRunReport(report: RunReport, outDir: string): Promise<string> {
  const runDir = safePath.join(outDir, runDirectoryName(report));
  // eslint-disable-next-line local/no-fs-mkdirSync, security/detect-non-literal-fs-filename -- the corpus output dir is caller-supplied; mkdir-recursive is the right call here
  mkdirSync(runDir, { recursive: true });

  const totals = computeTotals(report);
  const dump = {
    schema_version: report.schema_version,
    generated_at: report.generated_at,
    vat_version: report.vat_version,
    vat_commit: report.vat_commit,
    seed_file: report.seed_file,
    flags: report.flags,
    plugins: report.plugins,
    totals,
  };

  const summaryPath = safePath.join(runDir, 'summary.yaml');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- summaryPath composed under our run dir
  writeFileSync(summaryPath, yaml.stringify(dump, { lineWidth: 0, aliasDuplicateObjects: false }), 'utf-8');

  return runDir;
}
