/**
 * Checklist data for `vat skill review`
 *
 * Two artifacts live here:
 *
 * 1. `CODE_TO_SECTION` — maps every automated validation code to the
 *    checklist section it belongs under. When an automated finding fires,
 *    the review command groups it by section so the reviewer sees it next
 *    to the manual items in the same section.
 *
 * 2. `MANUAL_CHECKLIST_ITEMS` — the judgment-call items from the checklist,
 *    grouped by section. These are rendered as a ready-to-walk rubric so a
 *    human (or agent reviewer) can tick each item as they review.
 *
 * Source of truth: packages/vat-development-agents/resources/skills/skill-quality-checklist.md
 * Keep this file in sync with that document when the checklist changes.
 */

export type ChecklistSection =
  | 'Naming'
  | 'Description'
  | 'Body structure'
  | 'References and bundled files'
  | 'Frontmatter hygiene'
  | 'Cross-skill dependencies'
  | 'Readability'
  | 'Compatibility'
  | 'CLI-backed additional checks'
  | 'Other automated findings';

// Section name constants (used repeatedly in CODE_TO_SECTION and MANUAL_CHECKLIST_ITEMS
// below). Avoids sonarjs/no-duplicate-string and makes renaming trivial.
const SEC_NAMING: ChecklistSection = 'Naming';
const SEC_DESCRIPTION: ChecklistSection = 'Description';
const SEC_BODY: ChecklistSection = 'Body structure';
const SEC_REFERENCES: ChecklistSection = 'References and bundled files';
const SEC_FRONTMATTER: ChecklistSection = 'Frontmatter hygiene';
const SEC_CROSS_SKILL: ChecklistSection = 'Cross-skill dependencies';
const SEC_READABILITY: ChecklistSection = 'Readability';
const SEC_COMPAT: ChecklistSection = 'Compatibility';
const SEC_CLI_BACKED: ChecklistSection = 'CLI-backed additional checks';
const SEC_OTHER: ChecklistSection = 'Other automated findings';

export const CHECKLIST_SECTIONS: readonly ChecklistSection[] = [
  SEC_NAMING,
  SEC_DESCRIPTION,
  SEC_BODY,
  SEC_REFERENCES,
  SEC_FRONTMATTER,
  SEC_CROSS_SKILL,
  SEC_READABILITY,
  SEC_COMPAT,
  SEC_CLI_BACKED,
  SEC_OTHER,
] as const;

/**
 * Map each known validation code to its checklist section. Unknown codes are
 * caller-reported as `Other automated findings`.
 */
export const CODE_TO_SECTION: Record<string, ChecklistSection> = {
  // Naming
  SKILL_NAME_INVALID: SEC_NAMING,
  SKILL_NAME_RESERVED_WORD: SEC_NAMING,
  SKILL_NAME_XML_TAGS: SEC_NAMING,
  SKILL_NAME_MISMATCHES_DIR: SEC_NAMING,

  // Description
  SKILL_MISSING_DESCRIPTION: SEC_DESCRIPTION,
  SKILL_DESCRIPTION_EMPTY: SEC_DESCRIPTION,
  SKILL_DESCRIPTION_XML_TAGS: SEC_DESCRIPTION,
  SKILL_DESCRIPTION_TOO_LONG: SEC_DESCRIPTION,
  SKILL_DESCRIPTION_OVER_CLAUDE_CODE_LIMIT: SEC_DESCRIPTION,
  SKILL_DESCRIPTION_FILLER_OPENER: SEC_DESCRIPTION,
  SKILL_DESCRIPTION_WRONG_PERSON: SEC_DESCRIPTION,
  DESCRIPTION_TOO_VAGUE: SEC_DESCRIPTION,

  // Body structure
  SKILL_LENGTH_EXCEEDS_RECOMMENDED: SEC_BODY,
  SKILL_TOTAL_SIZE_LARGE: SEC_BODY,
  SKILL_TOO_MANY_FILES: SEC_BODY,
  SKILL_TIME_SENSITIVE_CONTENT: SEC_BODY,
  NO_PROGRESSIVE_DISCLOSURE: SEC_BODY,

  // References and bundled files
  PACKAGED_UNREFERENCED_FILE: SEC_REFERENCES,
  PACKAGED_BROKEN_LINK: SEC_REFERENCES,
  REFERENCE_TOO_DEEP: SEC_REFERENCES,
  LINK_OUTSIDE_PROJECT: SEC_REFERENCES,
  LINK_TARGETS_DIRECTORY: SEC_REFERENCES,
  LINK_TO_NAVIGATION_FILE: SEC_REFERENCES,
  LINK_TO_GITIGNORED_FILE: SEC_REFERENCES,
  LINK_MISSING_TARGET: SEC_REFERENCES,
  LINK_TO_SKILL_DEFINITION: SEC_REFERENCES,
  LINK_DROPPED_BY_DEPTH: SEC_REFERENCES,
  LINK_INTEGRITY_BROKEN: SEC_REFERENCES,

  // Compatibility (orthogonal to the formal checklist but worth its own section)
  CAPABILITY_LOCAL_SHELL: SEC_COMPAT,
  CAPABILITY_EXTERNAL_CLI: SEC_COMPAT,
  CAPABILITY_BROWSER_AUTH: SEC_COMPAT,
  COMPAT_TARGET_INCOMPATIBLE: SEC_COMPAT,
  COMPAT_TARGET_NEEDS_REVIEW: SEC_COMPAT,
  COMPAT_TARGET_UNDECLARED: SEC_COMPAT,
};

/**
 * Return the checklist section for a code, falling back to
 * 'Other automated findings' for unmapped codes.
 */
export function sectionForCode(code: string): ChecklistSection {
  return CODE_TO_SECTION[code] ?? SEC_OTHER;
}

/**
 * Judgment-call checklist items (no automated code). Synced from the
 * checklist file as of 2026-04-18. Update when the checklist changes.
 *
 * Items are phrased as questions the reviewer should answer. `[A]` flags
 * items that directly mirror Anthropic guidance; `[VAT]` flags VAT-opinionated
 * additions. Prefixes help a reviewer weigh how strictly to apply each item.
 */
export const MANUAL_CHECKLIST_ITEMS: Readonly<Record<ChecklistSection, readonly string[]>> = {
  [SEC_NAMING]: [
    '[A] Does the name use gerund form (e.g. processing-pdfs) or an acceptable alternative (noun/verb phrase)?',
    '[A] Does the name avoid vague terms like helper, utils, tools?',
  ],
  [SEC_DESCRIPTION]: [
    '[A] Does the description lead with trigger keywords (not filler)?',
    '[A] Is the voice third-person throughout (no "I can..." or "You can...")?',
    '[A] Does the description use the "Use when <concrete trigger>" pattern or an equivalent verb-phrase opener?',
    '[A] Is the description specific enough to disambiguate from siblings — both what it does and when to use it?',
    '[VAT] If a reviewer only saw this name+description, could an agent reliably decide when to load the skill?',
  ],
  [SEC_BODY]: [
    '[A] Does the first 3 lines of SKILL.md state the purpose clearly?',
    '[A] Is the skill single-responsibility, or does it combine multiple unrelated capabilities?',
    '[A] Is terminology consistent throughout (one term per concept)?',
  ],
  [SEC_REFERENCES]: [
    '[A] Are reference files one level deep (linked directly from SKILL.md, not via hubs)?',
    '[A] Do reference files over 100 lines include a table of contents at the top?',
    '[A] Does `vat skills build` succeed and does `vat verify` pass with zero errors?',
    '[A] If an agent saw only the name+description, would it know when to load this skill (the trigger test)?',
  ],
  [SEC_FRONTMATTER]: [
    '[VAT] Is the frontmatter conservative — only name, description, allowed-tools (and argument-hint for slash-commands)?',
    '[VAT] Is YAML styling consistent across sibling skills (folded vs inline strings)?',
  ],
  [SEC_CROSS_SKILL]: [
    '[VAT] If this skill depends on a sibling (auth, pre-flight, setup), is that dependency stated in the description?',
  ],
  [SEC_READABILITY]: [
    '[VAT] Are large tables (>~15 rows) moved to reference files rather than living in SKILL.md?',
  ],
  [SEC_COMPAT]: [
    '[VAT] If the skill requires a local shell / external CLI / browser auth, is that reality reflected in the declared targets?',
  ],
  [SEC_CLI_BACKED]: [
    '[VAT] Does the skill guard for the CLI binary existing before invoking it?',
    '[VAT] If the CLI needs credentials, does the skill pre-flight the auth check and fail fast with guidance?',
    '[VAT] Are exact CLI invocation patterns provided (with placeholder arguments) rather than ambiguous prose?',
    '[VAT] Is error-handling guidance present (retryable vs fatal, when to stop and ask)?',
    '[VAT] Are bare command names avoided in prose/tables (wrapped in code blocks or contextualized)?',
    '[VAT] Are the commands cross-platform (no `timeout`, GNU-only `sed` flags, `grep -P`, etc.) or documented alternatives?',
    '[VAT] Are bundled CLI binaries declared in `files` config (not copied by external scripts)?',
    '[VAT] Are bundled assets and templates documented in SKILL.md (explaining what ships and why)?',
  ],
  [SEC_OTHER]: [],
};
