/**
 * A SKILL.md past the parse input cap is refused by its size, before it is read, on every skill
 * lane that reads it for its frontmatter — the parse limit, `RESOURCE_PARSE_LIMIT_EXCEEDED` where
 * the lane reports codes — never parsed for the small block at its top.
 *
 * The file is sparse: a real frontmatter block, then zeros out to one byte past the default cap, so
 * a lane that read it and parsed only the block would see a valid skill and pass.
 */

import { truncateSync } from 'node:fs';

import { isParseLimitError, ParseLimitError, parseRefusal } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { importSkillToAgent } from '../../src/import.js';
import { readDeclaredSkillName } from '../../src/skill-identity.js';
import { createSkillContent, createTransitiveSkillStructure, setupTempDir, validateSkillWithTransitiveChecking } from '../test-helpers.js';

const { getTempDir } = setupTempDir('skill-md-input-cap-');

/** The default parse input cap. */
const CAP = 8 * 1024 * 1024;

/**
 * @returns A skill whose SKILL.md declares a valid name and description and is one byte past the cap
 */
function oversizeSkill(): string {
  const { skillPath } = createTransitiveSkillStructure(
    getTempDir(),
    {},
    createSkillContent({ name: 'oversize', description: 'A skill whose SKILL.md is one byte past the parse input cap.' }, '\n# Oversize\n'),
  );
  truncateSync(skillPath, CAP + 1);
  return skillPath;
}

describe('a SKILL.md one byte past the parse input cap', () => {
  it('is RESOURCE_PARSE_LIMIT_EXCEEDED at SKILL.md in validateSkill, naming the cap', async () => {
    const skillPath = oversizeSkill();

    const result = await validateSkillWithTransitiveChecking(skillPath, getTempDir());

    const found = result.issues.filter((issue) => issue.code === 'RESOURCE_PARSE_LIMIT_EXCEEDED');
    expect(found).toStrictEqual([expect.objectContaining({ severity: 'error', location: 'SKILL.md' })]);
    expect(found[0]?.message).toContain(parseRefusal(new ParseLimitError('inputBytes', CAP)).reason);
  });

  it('is the parse limit, thrown, when its declared name is read', async () => {
    const error: unknown = await readDeclaredSkillName(oversizeSkill(), {}).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(isParseLimitError(error) ? error.limit : error).toBe('inputBytes');
  });

  it('is refused by import, naming the cap', async () => {
    const skillPath = oversizeSkill();

    const result = await importSkillToAgent({ skillPath, outputPath: safePath.join(getTempDir(), 'agent.yaml') });

    expect(result).toMatchObject({ success: false, refusal: 'INPUT_UNREADABLE' });
    expect(result.success ? '' : result.error).toContain(parseRefusal(new ParseLimitError('inputBytes', CAP)).reason);
  });

  it('is read whole at exactly the cap, as a skill like any other', async () => {
    const skillPath = oversizeSkill();
    truncateSync(skillPath, CAP);

    expect(await readDeclaredSkillName(skillPath, {})).toBe('oversize');
  });
});
