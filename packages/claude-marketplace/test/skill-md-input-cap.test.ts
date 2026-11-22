/**
 * A SKILL.md past the parse input cap is refused by its size, before it is read, on each
 * marketplace lane that reads one for its frontmatter — the compatibility analyzer, the settings
 * checker and the skill inventory — under the one cap every dispatcher holds (the population's).
 * A lane that read the file and parsed only the block at its top would see a valid skill
 * declaring `allowed-tools: Bash` and report it as checked. Each lane names the refusal in the one
 * sentence every lane gives (`parseRefusal`), and the inventory under its code.
 *
 * The cap is in the file's own bytes: a UTF-16 SKILL.md under it is read on every lane, though
 * its text would be past it as UTF-8.
 *
 * That wide file is megabytes of text, so each lane is also held to its counted scans of it:
 * the compatibility analyzer runs the skill-text core over the whole text exactly once, the
 * settings checker and the inventory never run it on this thread, and every lane hands the
 * parse dispatcher the frontmatter block alone, exactly once. A lane that scanned the file
 * twice, or parsed its body, would pay a second pass over megabytes and change no answer.
 */

import * as fs from 'node:fs/promises';
import { dirname } from 'node:path';

import type * as Resources from '@vibe-agent-toolkit/resources';
import { ParseCache, ParseDispatcher, ParseLimitError, parseRefusal } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { analyzeCompatibility } from '../src/compatibility-analyzer.js';
import { extractClaudeSkillInventory, NO_GIT_TRACKER } from '../src/inventory/extract-skill.js';
import type { InventoryPopulation } from '../src/inventory/inventory-population.js';
import { checkSettingsCompatibility } from '../src/settings/settings-compat-checker.js';

import { BASH_SKILL, DENY_BASH, SKILLS, setupRefusedSkillFixture, writeSkill } from './refused-skill-fixture.js';

/** Every dispatcher's input cap: the population's, which no lane names a different one of. */
const CAP = new ParseDispatcher(new ParseCache({ enabled: false }), {}).inputBytes;
const REASON = parseRefusal(new ParseLimitError('inputBytes', CAP)).reason;
const OVERSIZE = 'skills/oversize/SKILL.md';
const WIDE = 'skills/wide/SKILL.md';

/** The length of every text the skill-text core runs over on this thread, in call order. */
const coreRuns = vi.hoisted(() => ({ textLengths: [] as number[] }));

vi.mock('@vibe-agent-toolkit/resources', async (importOriginal) => {
  const actual = await importOriginal<typeof Resources>();
  return {
    ...actual,
    skillTextFactsOf: (...args: Parameters<typeof actual.skillTextFactsOf>): ReturnType<typeof actual.skillTextFactsOf> => {
      coreRuns.textLengths.push(args[0].length);
      return actual.skillTextFactsOf(...args);
    },
  };
});

/** The wide skill's text: a Bash-declaring frontmatter block, then megabytes of CJK body. */
const WIDE_TEXT = `${BASH_SKILL('wide')}${'字'.repeat(Math.floor(CAP * 0.4))}\n`;

/** The length of the one content each lane hands the dispatcher: the wide skill's frontmatter block, fences included. */
const WIDE_BLOCK = BASH_SKILL('wide').indexOf('\n---\n') + '\n---\n'.length;

/**
 * A Bash-declaring SKILL.md in UTF-16LE (with its BOM) whose bytes are under {@link CAP} and whose
 * text is past it as UTF-8: each CJK character is two bytes here and three in UTF-8.
 */
function wideSkill(): Buffer {
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(WIDE_TEXT, 'utf16le')]);
  if (bytes.length > CAP || Buffer.byteLength(WIDE_TEXT, 'utf8') <= CAP) throw new Error('the wide fixture no longer straddles the cap');
  return bytes;
}

let dispatcher: ParseDispatcher;

/**
 * Run one lane, counting its scans: each text the skill-text core ran over on this thread, and
 * each content handed to the parse dispatcher, by length.
 */
async function counted<T>(lane: () => Promise<T>): Promise<{ result: T; coreRuns: number[]; parses: number[] }> {
  coreRuns.textLengths.length = 0;
  const parse = vi.spyOn(dispatcher, 'parse');
  try {
    const result = await lane();
    return { result, coreRuns: [...coreRuns.textLengths], parses: parse.mock.calls.map(([keyed]) => keyed.content.length) };
  } finally {
    parse.mockRestore();
  }
}

beforeAll(() => {
  dispatcher = new ParseDispatcher(new ParseCache({ enabled: false }), {});
});

afterAll(async () => {
  await dispatcher.shutdown();
});

describe('a SKILL.md one byte past the run\'s parse input cap', () => {
  const getFixture = setupRefusedSkillFixture('vat-skill-md-input-cap-');
  let oversize: string;

  beforeAll(async () => {
    oversize = await writeSkill(safePath.join(getFixture().pluginDir, SKILLS, 'oversize'), BASH_SKILL('oversize'));
    await fs.truncate(oversize, CAP + 1);
  });

  it('is unchecked by the compatibility analyzer, in the one refusal sentence', async () => {
    const result = await analyzeCompatibility(getFixture().pluginDir, getFixture().pluginDir, dispatcher);

    expect(result.evidence.filter((e) => e.location.file === OVERSIZE)).toEqual([]);
    expect(result.unchecked.find((u) => u.path === OVERSIZE)?.reason).toBe(REASON);
  });

  it('is unchecked by the settings checker, in the one refusal sentence', async () => {
    const check = await checkSettingsCompatibility(getFixture().pluginDir, DENY_BASH, dispatcher);

    expect(check.conflicts).toEqual([]);
    expect(check.unchecked.find((u) => u.path === oversize)?.reason).toBe(REASON);
  });

  it('is a refusal row in the skill inventory, under its code and sentence, and declares no name', async () => {
    const inventory = await extractClaudeSkillInventory(oversize, { dispatcher, gitTrackerSource: NO_GIT_TRACKER });

    expect(inventory.manifest.name).toBe('');
    expect(inventory.parseErrors.filter((row) => row.path === oversize)).toStrictEqual([
      { path: oversize, message: REASON, parseRefused: 'RESOURCE_PARSE_LIMIT_EXCEEDED' },
    ]);
  });
});

describe('a UTF-16 SKILL.md under the cap in its own bytes and past it as UTF-8', () => {
  const getFixture = setupRefusedSkillFixture('vat-skill-md-wide-');
  let wide: string;

  beforeAll(async () => {
    wide = await writeSkill(safePath.join(getFixture().pluginDir, SKILLS, 'wide'), '');
    await fs.writeFile(wide, wideSkill());
  });

  it('is checked by the compatibility analyzer, scanning its text once and parsing only its block', async () => {
    const { result, coreRuns, parses } = await counted(() => analyzeCompatibility(getFixture().pluginDir, getFixture().pluginDir, dispatcher));

    expect(result.unchecked).toEqual([]);
    expect(result.evidence.some((e) => e.location.file === WIDE)).toBe(true);
    expect({ coreRuns, parses }).toEqual({ coreRuns: [WIDE_TEXT.length], parses: [WIDE_BLOCK] });
  });

  it('is checked by the settings checker, parsing only its block, once', async () => {
    const { result: check, coreRuns, parses } = await counted(() => checkSettingsCompatibility(getFixture().pluginDir, DENY_BASH, dispatcher));

    expect(check.unchecked).toEqual([]);
    expect(check.conflicts).not.toEqual([]);
    expect({ coreRuns, parses }).toEqual({ coreRuns: [], parses: [WIDE_BLOCK] });
  });

  it('declares its name in the skill inventory, parsing only its block, once', async () => {
    // The link walk answered by a population, as `vat inventory`'s projection lane answers it: this
    // test is the frontmatter's. Left to its fallback, the walk builds a registry with a parse pool
    // of its own and parses the whole megabyte body there, unseen by `counted` and uncached on a
    // fresh runner: seconds on CI, past the timeout on the Node floor.
    const asked: string[] = [];
    // A whole population that holds the skill with no links, no refusals and no store miss: the
    // skill lane reads only `membersOf` and `parseRefusedAmong`, and `asked` proves it took this lane.
    const noLinks = {
      root: dirname(wide),
      membersOf: (skillMdPath: string) => {
        asked.push(skillMdPath);
        return [];
      },
      parseRefusedAmong: () => [],
      refusalRows: { blobs: [], blobConditions: [], resourceRealizations: [] },
      storeMiss: undefined,
    } satisfies InventoryPopulation;
    const { result: inventory, coreRuns, parses } = await counted(() =>
      extractClaudeSkillInventory(wide, { dispatcher, gitTrackerSource: NO_GIT_TRACKER, sharedPopulation: noLinks }));

    expect(asked, 'the walk was answered by the population, not a registry of its own').toEqual([wide]);
    expect(inventory.parseErrors).toEqual([]);
    expect(inventory.manifest.name).toBe('wide');
    expect({ coreRuns, parses }).toEqual({ coreRuns: [], parses: [WIDE_BLOCK] });
  });
});
