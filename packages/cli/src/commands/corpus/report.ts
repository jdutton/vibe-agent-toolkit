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

import type { SeverityCounts } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';
import * as yaml from 'yaml';

/** A row's audit: the `vat audit` report's own status, or `unloadable` when the audit could not run. */
export type AuditStatus = 'ok' | 'findings' | 'unloadable';
export type ReviewStatus = 'ok' | 'error' | 'skipped';

/**
 * One plugin's audit row. `summary` is the audit report's own — FINDINGS by
 * severity, the one meaning `summary` has — and `files_scanned` is the report's
 * `examined`, FILES: two denominators, so two keys, never one block mixing them.
 */
export interface AuditOutcome {
  status: AuditStatus;
  duration_ms: number;
  summary?: SeverityCounts;      // present when status != unloadable
  files_scanned?: number;        // present when status != unloadable
  findings_emitted?: number;     // present when status != unloadable
  output_path?: string;          // relative to run dir; absent on unloadable
  error?: string;                // present only on unloadable
}

/**
 * Outcome distribution for one plugin's review lane — the review-side mirror
 * of the audit row's counts. `skills_scanned` counts SKILLS (the denominator, like
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
  generated_at: string;          // ISO 8601
  vat_version: string;
  vat_commit: string;
  seed_file: string;             // path used at scan invocation
  flags: { with_review: boolean; debug: boolean };
  plugins: PluginRow[];
}

export interface RunTotals {
  plugins: number;
  /** Rows whose audit found nothing. */
  audit_ok: number;
  /** Rows whose audit found something — at any severity. */
  audit_findings: number;
  /** The subset of `audit_findings` with at least one error-severity finding. */
  audit_with_errors: number;
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
    audit_ok: 0,
    audit_findings: 0,
    audit_with_errors: 0,
    unloadable: 0,
  };

  for (const row of report.plugins) {
    switch (row.audit.status) {
      case 'ok': {
        totals.audit_ok += 1;
        break;
      }
      case 'findings': {
        totals.audit_findings += 1;
        if ((row.audit.summary?.errors ?? 0) > 0) totals.audit_with_errors += 1;
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
  // eslint-disable-next-line local/no-fs-mkdirSync -- the corpus output dir is caller-supplied; mkdir-recursive is the right call here
  mkdirSync(runDir, { recursive: true });

  const totals = computeTotals(report);
  const dump = {
    generated_at: report.generated_at,
    vat_version: report.vat_version,
    vat_commit: report.vat_commit,
    seed_file: report.seed_file,
    flags: report.flags,
    plugins: report.plugins,
    totals,
  };

  const summaryPath = safePath.join(runDir, 'summary.yaml');
  writeFileSync(summaryPath, yaml.stringify(dump, { lineWidth: 0, aliasDuplicateObjects: false }), 'utf-8');

  return runDir;
}
