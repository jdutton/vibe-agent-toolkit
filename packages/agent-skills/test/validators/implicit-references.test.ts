/**
 * Unit tests for extractImplicitReferences — detecting non-markdown-link
 * file references (backtick, bold, DOT, bare prose, @-prefix).
 */

import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { extractImplicitReferences } from '../../src/validators/skill-validator.js';
import {
  createSkillContent,
  createTransitiveSkillStructure,
  setupTempDir,
} from '../test-helpers.js';

// ---------------------------------------------------------------------------
// Constants & Helpers
// ---------------------------------------------------------------------------

const SKILL_FRONTMATTER = { name: 'test-skill', description: 'Test skill for implicit refs' };
const COMPANION_FILE = 'companion.md';
const COMPANION_CONTENT = '# Companion\n\nContent.';

/** Create a visited-files set containing just SKILL.md in the given dir */
function visitedSet(tempDir: string, ...extraFiles: string[]): Set<string> {
  const files = new Set<string>([path.resolve(tempDir, 'SKILL.md')]);
  for (const f of extraFiles) {
    files.add(path.resolve(tempDir, f));
  }
  return files;
}

/** Create a skill with a companion file, run extractImplicitReferences, return results */
function detectCompanionRef(tempDir: string, skillBody: string) {
  createTransitiveSkillStructure(
    tempDir,
    { [COMPANION_FILE]: COMPANION_CONTENT },
    createSkillContent(SKILL_FRONTMATTER, skillBody),
  );
  return extractImplicitReferences(tempDir, [COMPANION_FILE], visitedSet(tempDir));
}

describe('extractImplicitReferences', () => {
  const { getTempDir } = setupTempDir('implicit-refs-');

  // ---------------------------------------------------------------------------
  // Matching tests — parameterized
  // ---------------------------------------------------------------------------

  it.each([
    ['backtick-quoted', '\n# Skill\n\nSee `companion.md` for details.'],
    ['bold', '\n# Skill\n\nSee **companion.md** for details.'],
    ['DOT parenthetical', '\n# Skill\n\n"Dispatch subagent (./companion.md)"'],
    ['bare prose', '\n# Skill\n\nSee companion.md for details'],
    ['@-prefixed', '\n# Skill\n\n@companion.md'],
    ['./prefixed', '\n# Skill\n\nSee ./companion.md'],
    ['sentence-ending period', '\n# Skill\n\nSee companion.md. This document has details.'],
  ])('should detect %s file path', (_label, body) => {
    const results = detectCompanionRef(getTempDir(), body);

    expect(results).toHaveLength(1);
    expect(results[0]?.referencedFile).toBe(COMPANION_FILE);
  });

  it('should detect subdirectory path', () => {
    const tempDir = getTempDir();
    const subPath = 'references/domain-template.md';
    createTransitiveSkillStructure(
      tempDir,
      { [subPath]: '# Template\n\nContent.' },
      createSkillContent(SKILL_FRONTMATTER, '\n# Skill\n\nSee `references/domain-template.md` for details.'),
    );

    const results = extractImplicitReferences(tempDir, [subPath], visitedSet(tempDir));

    expect(results).toHaveLength(1);
    expect(results[0]?.referencedFile).toBe(subPath);
  });

  // ---------------------------------------------------------------------------
  // Non-matching tests
  // ---------------------------------------------------------------------------

  it('should NOT match file path inside a URL', () => {
    const results = detectCompanionRef(
      getTempDir(), '\n# Skill\n\nSee https://example.com/companion.md for docs.',
    );
    expect(results).toHaveLength(0);
  });

  it('should NOT match substring of another filename', () => {
    const results = detectCompanionRef(
      getTempDir(), '\n# Skill\n\nSee not-companion.md for details.',
    );
    expect(results).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it('should report multiple implicit references from one file', () => {
    const tempDir = getTempDir();
    createTransitiveSkillStructure(
      tempDir,
      {
        'alpha.md': '# Alpha\n\nContent.',
        'beta.md': '# Beta\n\nContent.',
      },
      createSkillContent(SKILL_FRONTMATTER, '\n# Skill\n\nSee `alpha.md` and `beta.md` for details.'),
    );

    const results = extractImplicitReferences(tempDir, ['alpha.md', 'beta.md'], visitedSet(tempDir));

    expect(results).toHaveLength(2);
    const files = results.map(r => r.referencedFile).sort((a, b) => a.localeCompare(b));
    expect(files).toEqual(['alpha.md', 'beta.md']);
  });

  it('should find references in non-SKILL.md visited files', () => {
    const tempDir = getTempDir();
    createTransitiveSkillStructure(
      tempDir,
      {
        'linked.md': '# Linked\n\nSee `orphan.md` for details.',
        'orphan.md': '# Orphan\n\nContent.',
      },
      createSkillContent(SKILL_FRONTMATTER, '\n# Skill\n\nSee [linked](./linked.md).'),
    );

    const results = extractImplicitReferences(
      tempDir, ['orphan.md'], visitedSet(tempDir, 'linked.md'),
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.referencedFile).toBe('orphan.md');
    expect(results[0]?.foundIn).toBe(path.resolve(tempDir, 'linked.md'));
  });

  it('should return empty array when no implicit references found', () => {
    const tempDir = getTempDir();
    createTransitiveSkillStructure(
      tempDir,
      { 'orphan.md': '# Orphan\n\nContent.' },
      createSkillContent(SKILL_FRONTMATTER, '\n# Skill\n\nNo mentions of any files here.'),
    );

    const results = extractImplicitReferences(tempDir, ['orphan.md'], visitedSet(tempDir));

    expect(results).toHaveLength(0);
  });

  it('should NOT match when basename is ambiguous (multiple files with same name)', () => {
    const tempDir = getTempDir();
    createTransitiveSkillStructure(
      tempDir,
      {
        'dir1/shared.md': '# Shared 1\n\nContent.',
        'dir2/shared.md': '# Shared 2\n\nContent.',
      },
      createSkillContent(SKILL_FRONTMATTER, '\n# Skill\n\nSee `shared.md` for details.'),
    );

    const results = extractImplicitReferences(
      tempDir, ['dir1/shared.md', 'dir2/shared.md'], visitedSet(tempDir),
    );

    expect(results).toHaveLength(0);
  });

  it('should report correct line number', () => {
    const tempDir = getTempDir();
    const body = '\n# Skill\n\nLine 1.\nLine 2.\nLine 3.\nLine 4.\nSee `companion.md` here.';
    const results = detectCompanionRef(tempDir, body);

    expect(results).toHaveLength(1);
    // Frontmatter is 4 lines (---\nname: ...\ndescription: ...\n---) + body lines
    expect(results[0]?.line).toBeGreaterThan(1);
    expect(results[0]?.matchedText).toContain(COMPANION_FILE);
  });
});
