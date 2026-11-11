/**
 * A SKILL.md past the parse input cap is refused by its size, before it is read, on each
 * marketplace lane that reads one for its frontmatter — the compatibility analyzer, the settings
 * checker and the skill inventory — and the cap is the one the run's dispatcher holds, not the
 * default. A lane that read the file and parsed only the block at its top would see a valid skill
 * declaring `allowed-tools: Bash` and report it as checked.
 */

import * as fs from 'node:fs/promises';

import { ParseCache, ParseDispatcher, ParseLimitError } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { analyzeCompatibility } from '../src/compatibility-analyzer.js';
import { extractClaudeSkillInventory, NO_GIT_TRACKER } from '../src/inventory/extract-skill.js';
import { checkSettingsCompatibility } from '../src/settings/settings-compat-checker.js';

import { BASH_SKILL, DENY_BASH, SKILLS, setupRefusedSkillFixture, writeSkill } from './refused-skill-fixture.js';

/** The run's cap — far under the default, so only a lane reading under the dispatcher's cap refuses. */
const CAP = 4096;
const REASON = new ParseLimitError('inputBytes', CAP).message;
const OVERSIZE = 'skills/oversize/SKILL.md';

const getFixture = setupRefusedSkillFixture('vat-skill-md-input-cap-');
let dispatcher: ParseDispatcher;
let oversize: string;

beforeAll(async () => {
  dispatcher = new ParseDispatcher(new ParseCache({ enabled: false }), { limits: { inputBytes: CAP } });
  oversize = await writeSkill(safePath.join(getFixture().pluginDir, SKILLS, 'oversize'), BASH_SKILL('oversize'));
  await fs.truncate(oversize, CAP + 1);
});

afterAll(async () => {
  await dispatcher.shutdown();
});

describe('a SKILL.md one byte past the run\'s parse input cap', () => {
  it('is unchecked by the compatibility analyzer, naming the cap', async () => {
    const result = await analyzeCompatibility(getFixture().pluginDir, getFixture().pluginDir, dispatcher);

    expect(result.evidence.filter((e) => e.location.file === OVERSIZE)).toEqual([]);
    expect(result.unchecked.find((u) => u.path === OVERSIZE)?.reason).toContain(REASON);
  });

  it('is unchecked by the settings checker, naming the cap', async () => {
    const check = await checkSettingsCompatibility(getFixture().pluginDir, DENY_BASH, dispatcher);

    expect(check.conflicts).toEqual([]);
    expect(check.unchecked.find((u) => u.path === oversize)?.reason).toContain(REASON);
  });

  it('is a parse error in the skill inventory, naming the cap, and declares no name', async () => {
    const inventory = await extractClaudeSkillInventory(oversize, { dispatcher, gitTrackerSource: NO_GIT_TRACKER });

    expect(inventory.manifest.name).toBe('');
    expect(inventory.parseErrors.map((row) => row.message).join('\n')).toContain(REASON);
  });
});
