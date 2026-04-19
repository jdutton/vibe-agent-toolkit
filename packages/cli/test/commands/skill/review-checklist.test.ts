/**
 * Unit tests for the code → checklist-section mapping used by
 * `vat skill review`. The mapping must cover every code listed in the
 * command's design and must not drift away from the checklist.
 */

import { describe, it, expect } from 'vitest';

import {
  CODE_TO_SECTION,
  CHECKLIST_SECTIONS,
  MANUAL_CHECKLIST_ITEMS,
  sectionForCode,
  type ChecklistSection,
} from '../../../src/commands/skill/review-checklist.js';

// Section-name constants shared across expectations (avoids duplicate-string noise)
const SEC_NAMING: ChecklistSection = 'Naming';
const SEC_DESCRIPTION: ChecklistSection = 'Description';
const SEC_BODY: ChecklistSection = 'Body structure';
const SEC_REFERENCES: ChecklistSection = 'References and bundled files';
const SEC_COMPAT: ChecklistSection = 'Compatibility';

describe('review-checklist.sectionForCode', () => {
  const expectedMappings: ReadonlyArray<[string, ChecklistSection]> = [
    // Naming
    ['SKILL_NAME_INVALID', SEC_NAMING],
    ['RESERVED_WORD_IN_NAME', SEC_NAMING],
    ['SKILL_NAME_XML_TAGS', SEC_NAMING],
    ['SKILL_NAME_MISMATCHES_DIR', SEC_NAMING],
    // Description
    ['SKILL_MISSING_DESCRIPTION', SEC_DESCRIPTION],
    ['SKILL_DESCRIPTION_EMPTY', SEC_DESCRIPTION],
    ['SKILL_DESCRIPTION_XML_TAGS', SEC_DESCRIPTION],
    ['SKILL_DESCRIPTION_TOO_LONG', SEC_DESCRIPTION],
    ['SKILL_DESCRIPTION_OVER_CLAUDE_CODE_LIMIT', SEC_DESCRIPTION],
    ['SKILL_DESCRIPTION_FILLER_OPENER', SEC_DESCRIPTION],
    ['SKILL_DESCRIPTION_WRONG_PERSON', SEC_DESCRIPTION],
    ['DESCRIPTION_TOO_VAGUE', SEC_DESCRIPTION],
    // Body structure
    ['SKILL_LENGTH_EXCEEDS_RECOMMENDED', SEC_BODY],
    ['SKILL_TOTAL_SIZE_LARGE', SEC_BODY],
    ['SKILL_TOO_MANY_FILES', SEC_BODY],
    ['SKILL_TIME_SENSITIVE_CONTENT', SEC_BODY],
    ['NO_PROGRESSIVE_DISCLOSURE', SEC_BODY],
    // References
    ['PACKAGED_UNREFERENCED_FILE', SEC_REFERENCES],
    ['PACKAGED_BROKEN_LINK', SEC_REFERENCES],
    ['REFERENCE_TOO_DEEP', SEC_REFERENCES],
    ['LINK_OUTSIDE_PROJECT', SEC_REFERENCES],
    ['LINK_MISSING_TARGET', SEC_REFERENCES],
    ['LINK_INTEGRITY_BROKEN', SEC_REFERENCES],
    // Compatibility
    ['CAPABILITY_LOCAL_SHELL', SEC_COMPAT],
    ['CAPABILITY_EXTERNAL_CLI', SEC_COMPAT],
    ['CAPABILITY_BROWSER_AUTH', SEC_COMPAT],
    ['COMPAT_TARGET_INCOMPATIBLE', SEC_COMPAT],
    ['COMPAT_TARGET_NEEDS_REVIEW', SEC_COMPAT],
    ['COMPAT_TARGET_UNDECLARED', SEC_COMPAT],
  ];

  it.each(expectedMappings)('maps %s to %s', (code, section) => {
    expect(sectionForCode(code)).toBe(section);
    expect(CODE_TO_SECTION[code]).toBe(section);
  });

  it('maps unknown codes to "Other automated findings"', () => {
    expect(sectionForCode('SOMETHING_WE_HAVE_NEVER_EMITTED')).toBe('Other automated findings');
    expect(sectionForCode('')).toBe('Other automated findings');
  });

  it('declares at least one mapped code per checklist section (except Other)', () => {
    const sectionsWithMappings = new Set<ChecklistSection>(Object.values(CODE_TO_SECTION));
    // Every structured section should be reachable through at least one code,
    // except Frontmatter hygiene / Cross-skill dependencies / Readability
    // which are purely manual today — they only exist in MANUAL_CHECKLIST_ITEMS.
    const mappingRequired: ReadonlySet<ChecklistSection> = new Set([
      SEC_NAMING,
      SEC_DESCRIPTION,
      SEC_BODY,
      SEC_REFERENCES,
      SEC_COMPAT,
    ]);
    for (const section of mappingRequired) {
      expect(sectionsWithMappings.has(section)).toBe(true);
    }
  });

  it('provides manual items for every checklist section that has them', () => {
    // Every section defined in CHECKLIST_SECTIONS must have a key in
    // MANUAL_CHECKLIST_ITEMS (possibly empty for "Other automated findings").
    for (const section of CHECKLIST_SECTIONS) {
      expect(MANUAL_CHECKLIST_ITEMS).toHaveProperty(section);
      expect(Array.isArray(MANUAL_CHECKLIST_ITEMS[section])).toBe(true);
    }
  });
});
