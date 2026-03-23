/**
 * Unit tests for skill-validator.ts — transitive link traversal
 *
 * Tests BFS link graph walking, broken link detection, boundary checks,
 * unreferenced file detection, and cycle handling.
 */

import { describe, expect, it } from 'vitest';

import { validateSkill } from '../../src/validators/skill-validator.js';
import type { ValidationResult } from '../../src/validators/types.js';
import {
  createAndValidateTransitiveSkill,
  createSkillContent,
  createTransitiveSkillStructure,
  setupTempDir,
  validateSkillWithUnreferencedFileCheck,
} from '../test-helpers.js';

// ---------------------------------------------------------------------------
// Constants & Helpers
// ---------------------------------------------------------------------------

const TEST_SKILL_NAME = 'test-skill';
const TEST_SKILL_DESC = 'A test skill for link traversal';
const SKILL_BODY_NO_LINKS = '\n# Skill\n\nNo links here.';

function skillFrontmatter(): { name: string; description: string } {
  return { name: TEST_SKILL_NAME, description: TEST_SKILL_DESC };
}

function findIssues(result: ValidationResult, code: string): ValidationResult['issues'] {
  return result.issues.filter(i => i.code === code);
}

function skillWithLink(href: string, text = 'link'): string {
  return createSkillContent(skillFrontmatter(), `\n# Skill\n\nSee [${text}](${href}).`);
}

/**
 * Create a multi-file skill and assert that all expected files appear in linkedFiles.
 */
async function assertLinkedFilesFound(
  tempDir: string,
  files: Record<string, string>,
  skillBody: string,
  expectedSuffixes: string[],
): Promise<ValidationResult> {
  const { result } = await createAndValidateTransitiveSkill(tempDir, files, skillBody);
  expect(result.linkedFiles).toHaveLength(expectedSuffixes.length);
  const paths = result.linkedFiles?.map(f => f.path) ?? [];
  for (const suffix of expectedSuffixes) {
    expect(paths.some(p => p.endsWith(suffix))).toBe(true);
  }
  return result;
}

/**
 * Create files in tempDir, run validateSkillWithUnreferencedFileCheck, and
 * return the SKILL_UNREFERENCED_FILE issues.
 */
async function checkUnreferencedIssues(
  tempDir: string,
  files: Record<string, string>,
  skillBody: string,
): Promise<ValidationResult['issues']> {
  const { skillPath } = createTransitiveSkillStructure(tempDir, files, skillBody);
  const result = await validateSkillWithUnreferencedFileCheck(skillPath, tempDir);
  return findIssues(result, 'SKILL_UNREFERENCED_FILE');
}

// ---------------------------------------------------------------------------
// 1. Valid local links
// ---------------------------------------------------------------------------

describe('transitive link traversal — valid links', () => {
  const { getTempDir } = setupTempDir('skill-valid-links-');

  it('should populate linkedFiles for a skill with valid local links', async () => {
    const files = { 'docs/guide.md': '# Guide\n\nSome guide content.' };
    const { result } = await createAndValidateTransitiveSkill(
      getTempDir(), files, skillWithLink('./docs/guide.md', 'guide'),
    );

    expect(result.linkedFiles).toBeDefined();
    expect(result.linkedFiles).toHaveLength(1);

    const first = result.linkedFiles?.[0];
    expect(first?.path).toContain('guide.md');
    expect(first?.lineCount).toBeGreaterThan(0);
    expect(first?.linksFound).toBe(0);
    expect(first?.linksValidated).toBe(0);
    expect(first?.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Broken links
// ---------------------------------------------------------------------------

describe('transitive link traversal — broken links', () => {
  const { getTempDir } = setupTempDir('skill-broken-links-');

  it('should report LINK_INTEGRITY_BROKEN for missing link target', async () => {
    const { result } = await createAndValidateTransitiveSkill(
      getTempDir(), {}, skillWithLink('./nonexistent.md', 'missing'),
    );

    const issues = findIssues(result, 'LINK_INTEGRITY_BROKEN');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('nonexistent.md');
    expect(issues[0]?.fix).toBeDefined();
    expect(result.status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// 3. Link escaping directory
// ---------------------------------------------------------------------------

describe('transitive link traversal — boundary escape', () => {
  const { getTempDir } = setupTempDir('skill-boundary-');

  it('should report OUTSIDE_PROJECT_BOUNDARY for link escaping skill directory', async () => {
    const { result } = await createAndValidateTransitiveSkill(
      getTempDir(), {}, skillWithLink('../outside.md', 'parent'),
    );

    const issues = findIssues(result, 'OUTSIDE_PROJECT_BOUNDARY');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('warning');
    expect(issues[0]?.message).toContain('../outside.md');
  });
});

// ---------------------------------------------------------------------------
// 4. Unreferenced files — checkUnreferencedFiles=true
// ---------------------------------------------------------------------------

describe('transitive link traversal — unreferenced files', () => {
  const { getTempDir } = setupTempDir('skill-unreferenced-');

  it('should report SKILL_UNREFERENCED_FILE when checkUnreferencedFiles=true', async () => {
    const issues = await checkUnreferencedIssues(
      getTempDir(),
      { 'orphan.md': '# Orphan\n\nNot linked from SKILL.md.' },
      createSkillContent(skillFrontmatter(), SKILL_BODY_NO_LINKS),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('info');
    expect(issues[0]?.message).toContain('orphan.md');
  });
});

// ---------------------------------------------------------------------------
// 4b. Unreferenced files — implicit references
// ---------------------------------------------------------------------------

describe('transitive link traversal — implicit references', () => {
  const { getTempDir } = setupTempDir('skill-implicit-refs-');

  it('should emit SKILL_IMPLICIT_REFERENCE instead of SKILL_UNREFERENCED_FILE for implicitly referenced files', async () => {
    const { skillPath } = createTransitiveSkillStructure(
      getTempDir(),
      { 'companion.md': '# Companion\n\nContent.' },
      createSkillContent(skillFrontmatter(), '\n# Skill\n\nSee `companion.md` for details.'),
    );
    const result = await validateSkillWithUnreferencedFileCheck(skillPath, getTempDir());

    expect(findIssues(result, 'SKILL_UNREFERENCED_FILE')).toHaveLength(0);
    expect(findIssues(result, 'SKILL_IMPLICIT_REFERENCE')).toHaveLength(1);
    expect(findIssues(result, 'SKILL_IMPLICIT_REFERENCE')[0]?.message).toContain('companion.md');
  });

  it('should still emit SKILL_UNREFERENCED_FILE for truly orphaned files', async () => {
    const { skillPath } = createTransitiveSkillStructure(
      getTempDir(),
      { 'orphan.md': '# Orphan\n\nNot mentioned anywhere.' },
      createSkillContent(skillFrontmatter(), '\n# Skill\n\nNo mentions of any files.'),
    );
    const result = await validateSkillWithUnreferencedFileCheck(skillPath, getTempDir());

    expect(findIssues(result, 'SKILL_UNREFERENCED_FILE')).toHaveLength(1);
    expect(findIssues(result, 'SKILL_IMPLICIT_REFERENCE')).toHaveLength(0);
  });

  it('should handle mixed: some implicit, some orphaned', async () => {
    const { skillPath } = createTransitiveSkillStructure(
      getTempDir(),
      {
        'referenced.md': '# Referenced\n\nContent.',
        'orphan.md': '# Orphan\n\nContent.',
      },
      createSkillContent(skillFrontmatter(), '\n# Skill\n\nSee `referenced.md` for details.'),
    );
    const result = await validateSkillWithUnreferencedFileCheck(skillPath, getTempDir());

    expect(findIssues(result, 'SKILL_IMPLICIT_REFERENCE')).toHaveLength(1);
    expect(findIssues(result, 'SKILL_UNREFERENCED_FILE')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Unreferenced files — checkUnreferencedFiles=false
// ---------------------------------------------------------------------------

describe('transitive link traversal — unreferenced files disabled', () => {
  const { getTempDir } = setupTempDir('skill-no-unreferenced-');

  it('should NOT report SKILL_UNREFERENCED_FILE when checkUnreferencedFiles=false', async () => {
    const { result } = await createAndValidateTransitiveSkill(
      getTempDir(),
      { 'orphan.md': '# Orphan\n\nNot linked.' },
      createSkillContent(skillFrontmatter(), SKILL_BODY_NO_LINKS),
    );

    expect(findIssues(result, 'SKILL_UNREFERENCED_FILE')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Circular links
// ---------------------------------------------------------------------------

describe('transitive link traversal — circular links', () => {
  const { getTempDir } = setupTempDir('skill-circular-');

  it('should handle circular links (A->B->A) without infinite loop', async () => {
    const result = await assertLinkedFilesFound(
      getTempDir(),
      { 'a.md': '# A\n\nSee [B](./b.md).', 'b.md': '# B\n\nSee [A](./a.md).' },
      skillWithLink('./a.md', 'A'),
      ['a.md', 'b.md'],
    );
    expect(findIssues(result, 'LINK_INTEGRITY_BROKEN')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Transitive links (SKILL->A->B)
// ---------------------------------------------------------------------------

describe('transitive link traversal — transitive links', () => {
  const { getTempDir } = setupTempDir('skill-transitive-');

  it('should traverse transitive links (SKILL->A->B)', async () => {
    await assertLinkedFilesFound(
      getTempDir(),
      { 'a.md': '# A\n\nSee [B](./b.md).', 'b.md': '# B\n\nLeaf node.' },
      skillWithLink('./a.md', 'A'),
      ['a.md', 'b.md'],
    );
  });
});

// ---------------------------------------------------------------------------
// 8. CLAUDE.md and README.md never flagged as unreferenced
// ---------------------------------------------------------------------------

describe('transitive link traversal — excluded from unreferenced', () => {
  const { getTempDir } = setupTempDir('skill-excluded-');

  it('should never flag CLAUDE.md or README.md as unreferenced', async () => {
    const issues = await checkUnreferencedIssues(
      getTempDir(),
      { 'CLAUDE.md': '# Claude config', 'README.md': '# README' },
      createSkillContent(skillFrontmatter(), '\n# Skill\n\nNo links to those files.'),
    );
    expect(issues).toHaveLength(0);
  });

  it('should never flag navigation file patterns as unreferenced', async () => {
    const issues = await checkUnreferencedIssues(
      getTempDir(),
      { 'index.md': '# Index', 'toc.md': '# TOC', 'overview.md': '# Overview' },
      createSkillContent(skillFrontmatter(), SKILL_BODY_NO_LINKS),
    );
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 9. Non-markdown asset linked — existence check, no traversal
// ---------------------------------------------------------------------------

describe('transitive link traversal — non-markdown assets', () => {
  const { getTempDir } = setupTempDir('skill-assets-');

  it('should check existence of non-markdown assets without traversing', async () => {
    const { result } = await createAndValidateTransitiveSkill(
      getTempDir(), { 'image.png': 'fake-png-data' }, skillWithLink('./image.png', 'diagram'),
    );

    expect(findIssues(result, 'LINK_INTEGRITY_BROKEN')).toHaveLength(0);
    expect(result.linkedFiles ?? []).toHaveLength(0);
  });

  it('should report LINK_INTEGRITY_BROKEN for missing non-markdown asset', async () => {
    const { result } = await createAndValidateTransitiveSkill(
      getTempDir(), {}, skillWithLink('./missing-image.png', 'diagram'),
    );

    const issues = findIssues(result, 'LINK_INTEGRITY_BROKEN');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('missing-image.png');
  });
});

// ---------------------------------------------------------------------------
// 10. External URLs and anchor-only links — skipped
// ---------------------------------------------------------------------------

describe('transitive link traversal — skipped link types', () => {
  const { getTempDir } = setupTempDir('skill-skipped-');

  it('should skip external URLs and anchor-only links', async () => {
    const body =
      '\n# Skill\n\n' +
      'See [external](https://example.com).\n' +
      'See [anchor](#heading).\n' +
      'See [email](mailto:user@example.com).\n';

    const { result } = await createAndValidateTransitiveSkill(
      getTempDir(), {}, createSkillContent(skillFrontmatter(), body),
    );

    expect(findIssues(result, 'LINK_INTEGRITY_BROKEN')).toHaveLength(0);
    expect(findIssues(result, 'OUTSIDE_PROJECT_BOUNDARY')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge: links with anchors to existing files
// ---------------------------------------------------------------------------

describe('transitive link traversal — links with anchors', () => {
  const { getTempDir } = setupTempDir('skill-anchors-');

  it('should resolve links with anchor fragments to the correct file', async () => {
    const files = { 'docs/guide.md': '# Guide\n\n## Section\n\nContent.' };
    const { result } = await createAndValidateTransitiveSkill(
      getTempDir(), files, skillWithLink('./docs/guide.md#section', 'guide section'),
    );

    expect(result.linkedFiles).toHaveLength(1);
    expect(result.linkedFiles?.[0]?.path).toContain('guide.md');
    expect(findIssues(result, 'LINK_INTEGRITY_BROKEN')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge: URL-encoded paths (%20, %26, etc.)
// ---------------------------------------------------------------------------

describe('transitive link traversal — URL-encoded paths', () => {
  const { getTempDir } = setupTempDir('skill-url-encoded-');

  it('should resolve %20-encoded spaces in link paths', async () => {
    const files = { 'My Folder/target.md': '# Target\n\nContent.' };
    const { result } = await createAndValidateTransitiveSkill(
      getTempDir(), files, skillWithLink('My%20Folder/target.md', 'target'),
    );

    expect(findIssues(result, 'LINK_INTEGRITY_BROKEN')).toHaveLength(0);
    expect(result.linkedFiles).toHaveLength(1);
    expect(result.linkedFiles?.[0]?.path).toContain('target.md');
  });

  it('should resolve %26-encoded ampersands in link paths', async () => {
    const files = { 'Fraud & Investigations/CLAUDE.md': '# Fraud\n\nContent.' };
    const { result } = await createAndValidateTransitiveSkill(
      getTempDir(), files, skillWithLink('Fraud%20%26%20Investigations/CLAUDE.md', 'fraud'),
    );

    expect(findIssues(result, 'LINK_INTEGRITY_BROKEN')).toHaveLength(0);
  });

  it('should handle invalid percent-encoding gracefully', async () => {
    const { result } = await createAndValidateTransitiveSkill(
      getTempDir(), {}, skillWithLink('bad%ZZencoding.md', 'bad'),
    );

    // Should not crash — falls back to raw href, reports broken link
    const issues = findIssues(result, 'LINK_INTEGRITY_BROKEN');
    expect(issues).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Edge: no rootDir provided — defaults to dirname(skillPath)
// ---------------------------------------------------------------------------

describe('transitive link traversal — rootDir default', () => {
  const { getTempDir } = setupTempDir('skill-rootdir-default-');

  it('should default rootDir to dirname(skillPath) when not provided', async () => {
    const { skillPath } = createTransitiveSkillStructure(
      getTempDir(), { 'doc.md': '# Doc\n\nContent.' }, skillWithLink('./doc.md', 'doc'),
    );

    const result = await validateSkill({ skillPath });

    expect(result.linkedFiles).toHaveLength(1);
    expect(findIssues(result, 'LINK_INTEGRITY_BROKEN')).toHaveLength(0);
  });
});
