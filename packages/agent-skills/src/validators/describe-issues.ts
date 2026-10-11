/**
 * The three fields a {@link ValidationResult} carries about its issue list —
 * `status`, `summary` and the human `description` — derived together, in the
 * one place every producer (skill, plugin, marketplace and registry
 * validators, their early exits, and the audit lanes that re-derive a result
 * after appending or filtering findings) takes them from.
 */

import { summarizeIssues, type ValidationIssue } from '@vibe-agent-toolkit/schema';

import type { ValidationResult } from './types.js';

/**
 * The sentence a clean result of each type reads as. Keyed by type — never
 * passed by the caller — so a lane that re-derives a result (audit after a
 * `severity: ignore` filter) says exactly what the producer said. A type with
 * no entry reads as its zero counts.
 */
const CLEAN_SENTENCE: Partial<Record<ValidationResult['type'], string>> = {
  'claude-plugin': 'Valid plugin',
  marketplace: 'Valid marketplace',
  registry: 'Valid registry',
};

/**
 * @param issues - The result's final issue list
 * @param type - The result's `type`; decides the clean sentence (see {@link CLEAN_SENTENCE})
 * @param halted - Why the lane stopped early ("Plugin manifest missing"). It PREFIXES
 *   the counts, so the findings gathered before the stop are still said.
 * @returns `status` and `summary` from the shared `summarizeIssues`, and the sentence
 */
export function describeIssues(
  issues: readonly ValidationIssue[],
  type: ValidationResult['type'],
  halted?: string,
): Pick<ValidationResult, 'status' | 'summary' | 'description'> {
  const { status, summary } = summarizeIssues(issues);
  const counts = `${summary.errors} errors, ${summary.warnings} warnings, ${summary.info} info`;
  const clean = CLEAN_SENTENCE[type];
  let description = counts;
  if (halted !== undefined) {
    description = `${halted}: ${counts}`;
  } else if (status === 'ok' && clean !== undefined) {
    description = clean;
  }
  return { status, summary, description };
}
