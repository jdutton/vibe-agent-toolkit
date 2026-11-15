/**
 * A SKILL.md past the parse input cap is refused by its size, before it is read, on each
 * marketplace lane that reads one for its frontmatter — the compatibility analyzer, the settings
 * checker and the skill inventory — and the cap is the one the run's dispatcher holds, not the
 * default. A lane that read the file and parsed only the block at its top would see a valid skill
 * declaring `allowed-tools: Bash` and report it as checked. Each lane names the refusal in the one
 * sentence every lane gives (`parseRefusal`), and the inventory under its code.
 *
 * The cap is in the file's own bytes: a UTF-16 SKILL.md under it is read on every lane, though
 * its text would be past it as UTF-8.
 */

import * as fs from 'node:fs/promises';

import { ParseCache, ParseDispatcher, ParseLimitError, parseRefusal } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { analyzeCompatibility } from '../src/compatibility-analyzer.js';
import { extractClaudeSkillInventory, NO_GIT_TRACKER } from '../src/inventory/extract-skill.js';
import { checkSettingsCompatibility } from '../src/settings/settings-compat-checker.js';

import { BASH_SKILL, DENY_BASH, SKILLS, setupRefusedSkillFixture, writeSkill } from './refused-skill-fixture.js';

/** The run's cap — far under the default, so only a lane reading under the dispatcher's cap refuses. */
const CAP = 4096;
const REASON = parseRefusal(new ParseLimitError('inputBytes', CAP)).reason;
const OVERSIZE = 'skills/oversize/SKILL.md';
const WIDE = 'skills/wide/SKILL.md';

/**
 * A Bash-declaring SKILL.md in UTF-16LE (with its BOM) whose bytes are under {@link CAP} and whose
 * text is past it as UTF-8: each CJK character is two bytes here and three in UTF-8.
 */
function wideSkill(): Buffer {
  const text = `${BASH_SKILL('wide')}${'字'.repeat(1900)}\n`;
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  if (bytes.length > CAP || Buffer.byteLength(text, 'utf8') <= CAP) throw new Error('the wide fixture no longer straddles the cap');
  return bytes;
}

let dispatcher: ParseDispatcher;

beforeAll(() => {
  dispatcher = new ParseDispatcher(new ParseCache({ enabled: false }), { limits: { inputBytes: CAP } });
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

  it('is checked by the compatibility analyzer', async () => {
    const result = await analyzeCompatibility(getFixture().pluginDir, getFixture().pluginDir, dispatcher);

    expect(result.unchecked).toEqual([]);
    expect(result.evidence.some((e) => e.location.file === WIDE)).toBe(true);
  });

  it('is checked by the settings checker', async () => {
    const check = await checkSettingsCompatibility(getFixture().pluginDir, DENY_BASH, dispatcher);

    expect(check.unchecked).toEqual([]);
    expect(check.conflicts).not.toEqual([]);
  });

  it('declares its name in the skill inventory', async () => {
    const inventory = await extractClaudeSkillInventory(wide, { dispatcher, gitTrackerSource: NO_GIT_TRACKER });

    expect(inventory.parseErrors).toEqual([]);
    expect(inventory.manifest.name).toBe('wide');
  });
});
