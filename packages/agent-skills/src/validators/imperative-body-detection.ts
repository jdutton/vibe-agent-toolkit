/**
 * Non-imperative body detector (gray-zone heuristic, info severity).
 *
 * Emits SKILL_BODY_NOT_IMPERATIVE for lines that open with a second-
 * person modal phrase ("You should…", "You can…", "You need to…",
 * "You must…", "You will…", "You may…") outside fenced code blocks
 * and quoted blocks.
 *
 * Plugin-dev's "Mistake 3: Second Person Writing" identifies imperative
 * form as more agent-readable. Heuristic; ships at info to gather corpus
 * signal before any promotion.
 */

import { CODE_REGISTRY } from './code-registry.js';
import type { ValidationIssue } from './types.js';

// Targeted modals only — excludes "are" and "did" so we match instructional
// constructions, not factual ones.
const SECOND_PERSON_OPENER_RE = /^You\s+(should|can|need|must|will|may)\b/i;

const FENCE_RE = /^\s*```/;
const QUOTE_RE = /^\s*>/;

export function detectNonImperativeBody(
  body: string,
  location: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const entry = CODE_REGISTRY.SKILL_BODY_NOT_IMPERATIVE;

  let inFence = false;
  const lines = body.split('\n');
  for (const [idx, line] of lines.entries()) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (QUOTE_RE.test(line)) continue;

    const match = SECOND_PERSON_OPENER_RE.exec(line);
    if (match) {
      const lineNumber = idx + 1;
      const sample = line.slice(0, 80);
      issues.push({
        severity: entry.defaultSeverity,
        code: 'SKILL_BODY_NOT_IMPERATIVE',
        message: `Second-person opener "${sample.trim()}" — prefer imperative form (e.g. "Configure…").`,
        location: `${location}:${lineNumber}`,
        fix: entry.fix,
        reference: entry.reference,
      });
    }
  }

  return issues;
}
