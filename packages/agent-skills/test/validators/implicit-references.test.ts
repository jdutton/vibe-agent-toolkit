/**
 * Unit tests for extractImplicitReferences — detecting non-markdown-link
 * file references (backtick, bold, DOT, bare prose, @-prefix).
 */

import { NO_GIT_MEMBERS, RunContentCache } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { refuseAsyncFs } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';

import { extractImplicitReferences, type ImplicitReference } from '../../src/validators/skill-validator.js';
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
  const files = new Set<string>([safePath.resolve(tempDir, 'SKILL.md')]);
  for (const f of extraFiles) {
    files.add(safePath.resolve(tempDir, f));
  }
  return files;
}

/** {@link extractImplicitReferences} over a run's reader of its own, which reads from disk. */
function implicitRefs(tempDir: string, unreferenced: readonly string[], visited: ReadonlySet<string>): Promise<ImplicitReference[]> {
  return extractImplicitReferences(tempDir, unreferenced, visited, new RunContentCache(NO_GIT_MEMBERS));
}

/** Create a skill with a companion file, run extractImplicitReferences, return results */
function detectCompanionRef(tempDir: string, skillBody: string) {
  createTransitiveSkillStructure(
    tempDir,
    { [COMPANION_FILE]: COMPANION_CONTENT },
    createSkillContent(SKILL_FRONTMATTER, skillBody),
  );
  return implicitRefs(tempDir, [COMPANION_FILE], visitedSet(tempDir));
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
  ])('should detect %s file path', async (_label, body) => {
    const results = await detectCompanionRef(getTempDir(), body);

    expect(results).toHaveLength(1);
    expect(results[0]?.referencedFile).toBe(COMPANION_FILE);
  });

  it('should detect subdirectory path', async () => {
    const tempDir = getTempDir();
    const subPath = 'references/domain-template.md';
    createTransitiveSkillStructure(
      tempDir,
      { [subPath]: '# Template\n\nContent.' },
      createSkillContent(SKILL_FRONTMATTER, '\n# Skill\n\nSee `references/domain-template.md` for details.'),
    );

    const results = await implicitRefs(tempDir, [subPath], visitedSet(tempDir));

    expect(results).toHaveLength(1);
    expect(results[0]?.referencedFile).toBe(subPath);
  });

  // ---------------------------------------------------------------------------
  // Non-matching tests
  // ---------------------------------------------------------------------------

  it('should NOT match file path inside a URL', async () => {
    const results = await detectCompanionRef(
      getTempDir(), '\n# Skill\n\nSee https://example.com/companion.md for docs.',
    );
    expect(results).toHaveLength(0);
  });

  it('should NOT match substring of another filename', async () => {
    const results = await detectCompanionRef(
      getTempDir(), '\n# Skill\n\nSee not-companion.md for details.',
    );
    expect(results).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it('should report multiple implicit references from one file', async () => {
    const tempDir = getTempDir();
    createTransitiveSkillStructure(
      tempDir,
      {
        'alpha.md': '# Alpha\n\nContent.',
        'beta.md': '# Beta\n\nContent.',
      },
      createSkillContent(SKILL_FRONTMATTER, '\n# Skill\n\nSee `alpha.md` and `beta.md` for details.'),
    );

    const results = await implicitRefs(tempDir, ['alpha.md', 'beta.md'], visitedSet(tempDir));

    expect(results).toHaveLength(2);
    const files = results.map(r => r.referencedFile).sort((a, b) => a.localeCompare(b));
    expect(files).toEqual(['alpha.md', 'beta.md']);
  });

  it('should find references in non-SKILL.md visited files', async () => {
    const tempDir = getTempDir();
    createTransitiveSkillStructure(
      tempDir,
      {
        'linked.md': '# Linked\n\nSee `orphan.md` for details.',
        'orphan.md': '# Orphan\n\nContent.',
      },
      createSkillContent(SKILL_FRONTMATTER, '\n# Skill\n\nSee [linked](./linked.md).'),
    );

    const results = await implicitRefs(tempDir, ['orphan.md'], visitedSet(tempDir, 'linked.md'),
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.referencedFile).toBe('orphan.md');
    expect(results[0]?.foundIn).toBe(safePath.resolve(tempDir, 'linked.md'));
  });

  // A visited file is one the BFS already READ, so "cannot read it now" is a race
  // (skipped: nothing to scan) or a refusal — and a refusal used to be skipped
  // too, which silently dropped every reference that file carried.
  it('skips a visited file that has since vanished, and rethrows one that is refused', async () => {
    const tempDir = getTempDir();
    createTransitiveSkillStructure(
      tempDir,
      { [COMPANION_FILE]: COMPANION_CONTENT },
      createSkillContent(SKILL_FRONTMATTER, '\n# Skill\n\nSee `companion.md`.'),
    );
    const vanished = safePath.resolve(tempDir, 'gone.md');
    expect(await implicitRefs(tempDir, [COMPANION_FILE], visitedSet(tempDir, 'gone.md'))).toHaveLength(1);
    expect(vanished).not.toBe('');

    const skillMd = safePath.resolve(tempDir, 'SKILL.md');
    const restore = refuseAsyncFs('open', skillMd, 'EACCES');
    try {
      await expect(implicitRefs(tempDir, [COMPANION_FILE], visitedSet(tempDir))).rejects.toThrow(/EACCES/);
    } finally {
      restore();
    }
  });

  it('should return empty array when no implicit references found', async () => {
    const tempDir = getTempDir();
    createTransitiveSkillStructure(
      tempDir,
      { 'orphan.md': '# Orphan\n\nContent.' },
      createSkillContent(SKILL_FRONTMATTER, '\n# Skill\n\nNo mentions of any files here.'),
    );

    const results = await implicitRefs(tempDir, ['orphan.md'], visitedSet(tempDir));

    expect(results).toHaveLength(0);
  });

  it('should NOT match when basename is ambiguous (multiple files with same name)', async () => {
    const tempDir = getTempDir();
    createTransitiveSkillStructure(
      tempDir,
      {
        'dir1/shared.md': '# Shared 1\n\nContent.',
        'dir2/shared.md': '# Shared 2\n\nContent.',
      },
      createSkillContent(SKILL_FRONTMATTER, '\n# Skill\n\nSee `shared.md` for details.'),
    );

    const results = await implicitRefs(tempDir, ['dir1/shared.md', 'dir2/shared.md'], visitedSet(tempDir),
    );

    expect(results).toHaveLength(0);
  });

  it('should report correct line number', async () => {
    const tempDir = getTempDir();
    const body = '\n# Skill\n\nLine 1.\nLine 2.\nLine 3.\nLine 4.\nSee `companion.md` here.';
    const results = await detectCompanionRef(tempDir, body);

    expect(results).toHaveLength(1);
    // Frontmatter is 4 lines (---\nname: ...\ndescription: ...\n---) + body lines
    expect(results[0]?.line).toBeGreaterThan(1);
    expect(results[0]?.matchedText).toContain(COMPANION_FILE);
  });
});
