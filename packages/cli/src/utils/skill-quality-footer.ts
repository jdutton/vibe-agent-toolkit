/**
 * Skill-quality checklist footer
 *
 * Shared footer rendered by `vat audit` and `vat skills validate` when at
 * least one skill-level finding is present (warnings or errors against
 * SKILL.md files, or any of the newer quality codes). Suppressed on clean
 * runs so footers don't become ambient advertising.
 */

import type { createLogger } from './logger.js';

/**
 * Validation codes that always justify showing the footer when they appear,
 * even if no other skill-level issues fire (they are the quality-checklist
 * items most likely to benefit from the rubric's rationale).
 */
export const SKILL_QUALITY_FOOTER_CODES: ReadonlySet<string> = new Set([
  'SKILL_DESCRIPTION_OVER_CLAUDE_CODE_LIMIT',
  'SKILL_DESCRIPTION_FILLER_OPENER',
  'SKILL_DESCRIPTION_WRONG_PERSON',
  'SKILL_NAME_MISMATCHES_DIR',
  'SKILL_TIME_SENSITIVE_CONTENT',
]);

const FOOTER_LINE = `ℹ For the full pre-publication rubric and rationale on each finding, load the 'skill-quality-checklist' skill (from the vat-development-agents plugin) or see https://github.com/jdutton/vibe-agent-toolkit/blob/main/packages/vat-development-agents/resources/skills/skill-quality-checklist.md`;

/**
 * Render the footer to stderr when conditions are met.
 *
 * Shown when:
 *  - any issue with one of SKILL_QUALITY_FOOTER_CODES fired, OR
 *  - `hasSkillFindings` is true (at least one warning or error on a SKILL.md).
 *
 * Idempotent-safe: the caller decides once whether to call this.
 */
export function renderSkillQualityFooter(
  logger: ReturnType<typeof createLogger>,
  hasSkillFindings: boolean,
  emittedCodes: Iterable<string>,
): void {
  const hasNewCode = (() => {
    for (const code of emittedCodes) {
      if (SKILL_QUALITY_FOOTER_CODES.has(code)) {
        return true;
      }
    }
    return false;
  })();

  if (!hasSkillFindings && !hasNewCode) {
    return;
  }

  logger.info(`\n${FOOTER_LINE}`);
}
