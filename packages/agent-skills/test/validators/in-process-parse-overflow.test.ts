/**
 * A document deep enough to overflow an IN-PROCESS parse is an error finding,
 * `RESOURCE_PARSE_LIMIT_EXCEEDED` at that file — never a crash, never a warning.
 *
 * The skill lanes parse on this thread (`parseFileCached`, `parseMarkdown`, the
 * SKILL.md frontmatter parser), outside the bounded crawl route. The seed is a
 * 50,000-level flow sequence in the frontmatter, which overflows the stack
 * in `yaml` on the main thread and in a vitest worker alike (a `YAMLParseError` with code `RESOURCE_EXHAUSTION`,
 * probed on the main thread before this suite was written). Before the fix:
 *
 * - `validateSkill` demoted a linked document's overflow to a
 *   `LINK_INTEGRITY_BROKEN` WARNING, so the skill passed;
 * - `validateSkill` reported an overflowing SKILL.md as
 *   `SKILL_MISSING_FRONTMATTER`, telling the author to add the frontmatter they have;
 * - `validateSkillForPackaging` let the `YAMLParseError` escape: a crash.
 */

import { writeFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { activeErrorsOf, validateSkillForPackaging } from '../../src/validators/packaging-validator.js';
import { detectMissingReferencedPaths } from '../../src/validators/referenced-path-missing.js';
import {
  createSkillContent,
  createTransitiveSkillStructure,
  setupTempDir,
  validateSkillWithTransitiveChecking,
} from '../test-helpers.js';

const { getTempDir } = setupTempDir('in-process-parse-overflow-');

const LIMIT = 'RESOURCE_PARSE_LIMIT_EXCEEDED';

/**
 * Nesting depth for the seed. 5,000 overflows `yaml` on a plain `node` main
 * thread but NOT inside a vitest worker, whose stack is larger — a literal sized
 * for one thread is vacuous on the other. Sized well past both, and the suite
 * asserts the overflow happened (each test needs the finding), so a host whose
 * stack swallows even this reds rather than passing vacuously.
 */
const DEPTH = 50_000;

/** A frontmatter block nested deeply enough to overflow an in-process `yaml` parse. */
const DEEP_FRONTMATTER = `---\nname: deep\nnested: ${'['.repeat(DEPTH)}${']'.repeat(DEPTH)}\n---\n# Deep\n`;

const SKILL_LINKING_DEEP = createSkillContent(
  { name: 'linker', description: 'A skill whose one reference document nests its frontmatter pathologically deep.' },
  '\n# Linker\n\nSee [the reference](./reference.md).\n',
);

describe('validateSkill (the audit / skills-validate lane)', () => {
  it('reports a linked document that overflows the parse as an error at that document, not a warning', async () => {
    const { skillPath } = createTransitiveSkillStructure(getTempDir(), { 'reference.md': DEEP_FRONTMATTER }, SKILL_LINKING_DEEP);

    const result = await validateSkillWithTransitiveChecking(skillPath, getTempDir());

    const found = result.issues.filter((issue) => issue.code === LIMIT);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'error', location: 'reference.md' });
    expect(result.issues.map((issue) => issue.code)).not.toContain('LINK_INTEGRITY_BROKEN');
  });

  it('reports a SKILL.md whose frontmatter overflows the parse as the limit, not as missing frontmatter', async () => {
    const { skillPath } = createTransitiveSkillStructure(getTempDir(), {}, DEEP_FRONTMATTER);

    const result = await validateSkillWithTransitiveChecking(skillPath, getTempDir());

    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain(LIMIT);
    expect(codes).not.toContain('SKILL_MISSING_FRONTMATTER');
    expect(result.issues.find((issue) => issue.code === LIMIT)).toMatchObject({ severity: 'error', location: 'SKILL.md' });
  });
});

describe('validateSkillForPackaging (the build / skills-validate lane)', () => {
  it('reports a SKILL.md that overflows the parse as an error finding instead of throwing', async () => {
    const { skillPath } = createTransitiveSkillStructure(getTempDir(), {}, DEEP_FRONTMATTER);

    const result = await validateSkillForPackaging(skillPath);

    const found = activeErrorsOf(result).filter((issue) => issue.code === LIMIT);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'error', location: 'SKILL.md' });
  });
});

describe('detectMissingReferencedPaths (the packaged referenced-path check)', () => {
  it('reports a packaged document that overflows the parse as an error at it, and still checks its neighbour', async () => {
    const skillDir = getTempDir();
    const deepPath = safePath.join(skillDir, 'deep.md');
    const plainPath = safePath.join(skillDir, 'plain.md');
    writeFileSync(deepPath, DEEP_FRONTMATTER);
    writeFileSync(plainPath, '# Plain\n\nRun `scripts/setup.sh` first.\n');

    const issues = await detectMissingReferencedPaths([deepPath, plainPath], skillDir, 'claude-code');

    expect(issues.map((issue) => [issue.code, issue.severity, issue.location])).toEqual([
      [LIMIT, 'error', 'deep.md'],
      ['PACKAGED_REFERENCED_PATH_MISSING', 'warning', 'plain.md'],
    ]);
  });
});
