/**
 * A store-served SKILL.md whose body read the parse limit refuses: the file grew
 * past the input cap during the run, after the store's record of it. The only
 * read of its text on that path is the bundled-resource check's, and its refusal
 * must answer as the cold path's first read does: the refusal alone, with no
 * finding made from the stored facts before it.
 */

import { writeFileSync } from 'node:fs';

import {
  DEFAULT_PARSE_LIMITS,
  SKILL_TEXT_DECLARATION,
  skillTextFactsOf,
  type StoredDocumentFacts,
} from '@vibe-agent-toolkit/resources';
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import type { SkillTextRun } from '../../src/skill-text-lane.js';
import { setupParseRoute, setupTempDir, validateSkillThrough } from '../test-helpers.js';

const route = setupParseRoute();
const { getTempDir } = setupTempDir('skill-validator-stored-refusal-');

/** What the store recorded: the file before it grew, frontmatter a schema finding fires on. */
const RECORDED = '---\nname: Not_Kebab\ndescription: grew\n---\n# Grew\n';

/** A skill whose SKILL.md is now one byte past the cap, beside a bundled file no link covers. */
function grownSkill(): string {
  const skillDir = safePath.join(getTempDir(), 'grown');
  mkdirSyncReal(safePath.join(skillDir, 'references'), { recursive: true });
  writeFileSync(safePath.join(skillDir, 'references', 'orphan.md'), '# Orphan\n');
  const skillPath = safePath.join(skillDir, 'SKILL.md');
  writeFileSync(skillPath, RECORDED + 'x'.repeat(DEFAULT_PARSE_LIMITS.inputBytes + 1 - RECORDED.length));
  return skillPath;
}

function validate(skillPath: string, source: SkillTextRun['source']): ReturnType<typeof validateSkillThrough> {
  return validateSkillThrough(skillPath, getTempDir(), source, route);
}

describe('validateSkill: a store-served SKILL.md that grew past the cap mid-run', () => {
  it('answers the refusal alone, exactly as the cold read does', async () => {
    const skillPath = grownSkill();
    const stored = {
      facts: {
        frontmatter: { name: 'Not_Kebab', description: 'grew' },
        frontmatterError: undefined,
        frontmatterNotAMapping: false,
        links: [],
        skillText: skillTextFactsOf(RECORDED, SKILL_TEXT_DECLARATION),
      },
      decoding: { encoding: 'utf-8', encodingSource: 'assumed' },
    } as unknown as StoredDocumentFacts;

    const warm = await validate(skillPath, { storedDocument: (path) => Promise.resolve(path === skillPath ? stored : undefined) });
    const cold = await validate(skillPath, { storedDocument: () => Promise.resolve(undefined) });

    expect(cold.issues).toHaveLength(1);
    expect(warm.issues).toEqual(cold.issues);
    expect(warm.status).toBe(cold.status);
  });
});
