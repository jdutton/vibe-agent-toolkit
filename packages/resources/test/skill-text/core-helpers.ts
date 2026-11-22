import { SkillTextFactsSchema } from '../../src/schemas/skill-text-facts.js';
import { skillTextFactsOf } from '../../src/skill-text/core.js';
import { SKILL_TEXT_DECLARATION, type SkillTextFamily } from '../../src/skill-text/declaration.js';

/**
 * `[patternId, line, matchText]` for each record of `family`, in emission order.
 * Every result is parsed by the record's schema first, so each core test also
 * holds the core to it (family order, ordinals, pattern membership).
 */
export function recordsOf(text: string, family: SkillTextFamily): Array<[string, number, string]> {
  return SkillTextFactsSchema.parse(skillTextFactsOf(text, SKILL_TEXT_DECLARATION))
    .matches.filter((match) => match.family === family)
    .map((match) => [match.patternId, match.line, match.matchText]);
}

/** Lines joined with LF. */
export function lf(...lines: string[]): string {
  return lines.join('\n');
}
