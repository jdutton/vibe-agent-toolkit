/**
 * Reading a skill-text record: the matches of one family, in the order the
 * core emitted them (`ordinal`), which is the order every constructor emits its
 * issues and evidence in.
 */

import {
  type PatternId,
  SKILL_TEXT_FAMILY_PATTERNS,
  type SkillTextFacts,
  type SkillTextFamily,
  type SkillTextFamilyPatternId,
  type SkillTextMatch,
} from '@vibe-agent-toolkit/resources';

/** A match of `Family`, its pattern ID narrowed to the ones that family carries. */
type SkillTextFamilyMatch<Family extends SkillTextFamily> = SkillTextMatch & {
  readonly family: Family;
  readonly patternId: SkillTextFamilyPatternId<Family>;
};

/**
 * The matches of `family` in `facts`, in emission order, each pattern ID typed
 * as one of the family's, so a constructor keys its tables by it with no cast.
 *
 * @param facts - One document's skill-text record
 * @param family - The family a constructor builds from
 * @returns Its matches
 * @throws {Error} A VAT defect when a match of the family carries another family's
 *   pattern: the core never emits one and `SkillTextFactsSchema` refuses a stored one
 */
export function recordsOf<Family extends SkillTextFamily>(facts: SkillTextFacts, family: Family): Array<SkillTextFamilyMatch<Family>> {
  const allowed: readonly PatternId[] = SKILL_TEXT_FAMILY_PATTERNS[family];
  return facts.matches.filter((match): match is SkillTextFamilyMatch<Family> => {
    if (match.family !== family) return false;
    if (allowed.includes(match.patternId)) return true;
    throw new Error(`VAT defect: a ${family} skill-text record carries pattern ${match.patternId}, which is not its family's. Please report it.`);
  });
}
