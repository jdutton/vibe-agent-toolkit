/**
 * `validateSkill`'s frontmatter verdict comes from the SKILL.md's document facts:
 * the parse's decode of the block (`frontmatter`, `frontmatterError`,
 * `frontmatterNotAMapping`) and the record's `frontmatterFence`. A store-served
 * SKILL.md is therefore refused in the cold parser's own words with no read of
 * the file, and a store-served one and a read one give the same verdict, line
 * endings included: a lone CR is a line ending to the fence rule, to the whole
 * document's frontmatter decode and to the frontmatter parser alike.
 */

import { writeFileSync } from 'node:fs';

import { inMemoryContent, parseContentCached, type StoredDocumentFacts } from '@vibe-agent-toolkit/resources';
import { mkdirSyncReal, readWorkCounters, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { parseFrontmatter } from '../../src/parsers/frontmatter-parser.js';
import type { SkillTextRun } from '../../src/skill-text-lane.js';
import { setupParseRoute, setupTempDir, validateSkillThrough } from '../test-helpers.js';

const route = setupParseRoute();
const { getTempDir } = setupTempDir('skill-validator-frontmatter-facts-');

/** Each way a SKILL.md's frontmatter is refused, one document apiece. */
const REFUSED: ReadonlyArray<readonly [string, string]> = [
  ['no opening fence', '# No frontmatter\n\nUse the skill.\n'],
  ['no closing fence', '---\nname: unclosed\n# Unclosed\n'],
  ['an empty block', '---\n---\n# Empty\n'],
  ['invalid YAML', '---\nname: [unclosed\n---\n# Invalid\n'],
  ['a block that is not a mapping', '---\n- a\n- b\n---\n# Sequence\n'],
];

/** Documents whose frontmatter has lone-CR line endings, which every lane decodes as LF. */
const LONE_CR: ReadonlyArray<readonly [string, string]> = [
  [
    'a lone-CR document with a folded description',
    '---\rname: fm-lone-cr-folded\rdescription: >\r  Pins what the text detectors report for this fixture.\r  It exists only for tests.\r---\r# Lone CR folded\r\rUse the skill.\r',
  ],
  [
    'one lone CR between two keys',
    '---\nname: x\rdescription: Pins what the text detectors report for this fixture. It exists only for tests.\n---\n# Lone CR name\n\nUse the skill.\n',
  ],
];

let skillCount = 0;

/** A skill directory holding `text` as its SKILL.md. */
function skillWith(text: string): string {
  skillCount += 1;
  const skillDir = safePath.join(getTempDir(), `skill-${String(skillCount)}`);
  mkdirSyncReal(skillDir, { recursive: true });
  const skillPath = safePath.join(skillDir, 'SKILL.md');
  writeFileSync(skillPath, text);
  return skillPath;
}

/** A store serving `skillPath` with the facts of `text`'s whole-document markdown parse. */
async function storeServing(skillPath: string, text: string): Promise<SkillTextRun['source']> {
  const parsed = await parseContentCached(text, 'markdown', route);
  const stored = {
    facts: {
      frontmatter: parsed.frontmatter,
      frontmatterError: parsed.frontmatterError,
      frontmatterNotAMapping: parsed.frontmatterNotAMapping === true,
      links: parsed.links,
      skillText: parsed.skillText,
    },
    decoding: { encoding: 'utf-8', encodingSource: 'assumed' },
  } as unknown as StoredDocumentFacts;
  return { storedDocument: (path) => Promise.resolve(path === skillPath ? stored : undefined), holdsStore: true };
}

/** A run with no store: every file is read. */
const NO_STORE: SkillTextRun['source'] = { storedDocument: () => Promise.resolve(undefined), holdsStore: false };

function validate(skillPath: string, source: SkillTextRun['source']): ReturnType<typeof validateSkillThrough> {
  return validateSkillThrough(skillPath, getTempDir(), source, route);
}

/** `content.read` now. */
const reads = (): number => readWorkCounters()['content.read'];

describe('validateSkill: the frontmatter verdict from a SKILL.md\'s document facts', () => {
  it.each(REFUSED)('refuses %s in the frontmatter parser\'s words, served from the store with no read', async (_label, text) => {
    const skillPath = skillWith(text);
    const parsed = await parseFrontmatter(inMemoryContent(text), route);
    if (parsed.success) throw new Error('the fixture must be refused');
    const source = await storeServing(skillPath, text);

    const before = reads();
    const warm = await validate(skillPath, source);

    expect(reads() - before).toBe(0);
    expect(warm.issues).toEqual([expect.objectContaining({ code: 'SKILL_MISSING_FRONTMATTER', message: parsed.error })]);
    expect(warm.issues).toEqual((await validate(skillPath, NO_STORE)).issues);
  });

  it.each(LONE_CR)('decodes %s alike served and read, as the frontmatter parser does', async (_label, text) => {
    const skillPath = skillWith(text);
    const parsed = await parseFrontmatter(inMemoryContent(text), route);
    if (!parsed.success) throw new Error(`the frontmatter parser refused the fixture: ${parsed.error}`);

    const warm = await validate(skillPath, await storeServing(skillPath, text));
    const cold = await validate(skillPath, NO_STORE);

    expect(warm.metadata?.name).toBe(parsed.frontmatter['name']);
    expect(warm.metadata?.description).toBe(parsed.frontmatter['description']);
    expect(warm.issues).toEqual(cold.issues);
    expect(warm.metadata).toEqual(cold.metadata);
  });
});
