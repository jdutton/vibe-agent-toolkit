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
 *
 * The text half (the targeted modals only — not "are" or "did", so it matches
 * instructional constructions, not factual ones — outside fences and quotes,
 * over the frontmatter parser's body) is the skill-text core's
 * `imperativeBody` family in `@vibe-agent-toolkit/resources`.
 */

import type { SkillTextFacts } from '@vibe-agent-toolkit/resources';
import { CODE_REGISTRY, type ValidationIssue } from '@vibe-agent-toolkit/schema';

import { recordsOf } from './skill-text-records.js';

/**
 * @param facts - The SKILL.md's skill-text record; its `imperativeBody`
 *   records are over the body (frontmatter stripped), with body-relative lines.
 * @param location - Project-relative POSIX path of the file, per the
 *   `ValidationIssue` anchor contract. Build it with `issueLocation()`.
 */
export function detectNonImperativeBody(
  facts: SkillTextFacts,
  location: string,
): ValidationIssue[] {
  const entry = CODE_REGISTRY.SKILL_BODY_NOT_IMPERATIVE;
  return recordsOf(facts, 'imperativeBody').map(({ line, matchText: sample }) => ({
    severity: entry.defaultSeverity,
    code: 'SKILL_BODY_NOT_IMPERATIVE',
    message: `Second-person opener "${sample.trim()}" — prefer imperative form (e.g. "Configure…").`,
    location,
    line,
    fix: entry.fix,
    reference: entry.reference,
  }));
}
