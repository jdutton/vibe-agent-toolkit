/**
 * Unit tests for the code → checklist-section mapping used by
 * `vat skill review`. The mapping must cover every code listed in the
 * command's design and must not drift away from the checklist.
 */

import { CODE_REGISTRY } from '@vibe-agent-toolkit/schema';
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

/**
 * Registry codes that are DELIBERATELY not mapped, and therefore render under
 * `Other automated findings`.
 *
 * 🔑 This list is the point of the suite below. Every assertion above is a
 * hand-written subset — it can only fail for a code somebody remembered to add
 * to it — so a newly registered code was silently orphaned into the catch-all
 * with nothing anywhere going red. `PACKAGED_REFERENCED_PATH_MISSING` shipped
 * that way for its whole first release, sitting in `Other automated findings`
 * while its exact inverse `PACKAGED_UNREFERENCED_FILE` sat under references.
 *
 * So: adding a code to `CODE_REGISTRY` now forces a decision. Give it a section
 * in `CODE_TO_SECTION`, or write it here — but not neither. Writing it here is
 * a real answer for a code the review checklist has no section for: the
 * resource/link-graph and marketplace codes below are emitted by lanes
 * (`vat resources validate`, `vat audit` over a marketplace) that a skill review
 * does not walk, and the plugin-manifest ones describe the plugin around the
 * skill rather than the skill itself.
 */
const FALLS_TO_CATCH_ALL: ReadonlySet<string> = new Set([
  'ALLOW_EXPIRED',
  'ALLOW_UNUSED',
  'ALWAYS_LOADED_CONTEXT_BUDGET',
  'COMPONENT_DECLARED_BUT_MISSING',
  'COMPONENT_PRESENT_BUT_UNDECLARED',
  'DUPLICATE_RESOURCE_ID',
  'EXTERNAL_URL_DEAD',
  'EXTERNAL_URL_ERROR',
  'EXTERNAL_URL_TIMEOUT',
  'FILENAME_COLLISION',
  'FRONTMATTER_ANCHOR_MISSING',
  'FRONTMATTER_INVALID_YAML',
  'FRONTMATTER_LINK_BROKEN',
  'FRONTMATTER_LINK_TO_GITIGNORED',
  'FRONTMATTER_MISSING',
  'FRONTMATTER_SCHEMA_ERROR',
  'FRONTMATTER_UNKNOWN_LINK',
  'LINK_AUTH_DEAD',
  'LINK_AUTH_DEAD_OR_UNAUTHORIZED',
  'LINK_AUTH_FORBIDDEN',
  'LINK_AUTH_UNAUTHORIZED',
  'LINK_AUTH_UNVERIFIED',
  'LINK_BROKEN_ANCHOR',
  'LINK_BROKEN_FILE',
  'LINK_DEFERRED_ARTIFACT',
  'LINK_EXCLUDED_BY_PATTERN',
  'LINK_FROM_NON_ROUTABLE_FILE',
  'LINK_NORMALIZATION_MISMATCH',
  'LINK_TARGET_UNREADABLE',
  'LINK_TO_GITIGNORED',
  'LINK_TO_UNBUNDLED_DIRECTORY',
  'LINK_UNKNOWN',
  'LINK_UNRESOLVED_REFERENCE',
  'MALFORMED_HTML',
  'MARKETPLACE_PLUGIN_SOURCE_MISSING',
  'PACKAGED_TEST_INPUT',
  'PLUGIN_EXCLUDE_PATTERN_UNUSED',
  'PLUGIN_MISSING_AUTHOR',
  'PLUGIN_MISSING_DESCRIPTION',
  'PLUGIN_MISSING_LICENSE',
  'PLUGIN_NAME_NOT_KEBAB_CASE',
  'PLUGIN_TOPLEVEL_BIN_DIR',
  'REFERENCE_TARGET_MISSING',
  'REGISTRY_SHAPE_DRIFT',
  'RESOURCE_UNREADABLE',
  'SCAN_PATH_UNREADABLE',
  'SKILL_BODY_NOT_IMPERATIVE',
  'SKILL_CLAUDE_PLUGIN_NAME_MISMATCH',
  'SKILL_NAME_NOT_KEBAB_CASE',
  'SKILL_REFERENCES_BUT_NO_LINKS',
  'TREE_PROVENANCE_INDETERMINATE',
]);

describe('review-checklist accounts for every registry code', () => {
  const registryCodes = Object.keys(CODE_REGISTRY);

  it('reads a non-empty registry, so the checks below cannot pass vacuously', () => {
    expect(registryCodes.length).toBeGreaterThan(50);
  });

  it('accounts for every registry code — mapped, or listed as falling to the catch-all', () => {
    const unaccounted = registryCodes.filter(
      (code) => CODE_TO_SECTION[code] === undefined && !FALLS_TO_CATCH_ALL.has(code),
    );
    expect(
      unaccounted,
      'new CODE_REGISTRY codes: map them in CODE_TO_SECTION, or add them to FALLS_TO_CATCH_ALL',
    ).toEqual([]);
  });

  it('never lists a code as catch-all while also mapping it', () => {
    const contradictory = [...FALLS_TO_CATCH_ALL].filter(
      (code) => CODE_TO_SECTION[code] !== undefined,
    );
    expect(contradictory, 'listed as unmapped, but CODE_TO_SECTION maps it').toEqual([]);
  });

  it('holds no catch-all entry for a code the registry no longer has', () => {
    const stale = [...FALLS_TO_CATCH_ALL].filter((code) => !(code in CODE_REGISTRY));
    expect(stale, 'deleted or renamed codes still listed as catch-all').toEqual([]);
  });
});
