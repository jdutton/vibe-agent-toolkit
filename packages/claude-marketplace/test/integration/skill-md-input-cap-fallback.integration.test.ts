/**
 * `vat inventory <SKILL.md>` hands the skill extractor no population, so its link walk falls back
 * to a registry crawl that parses the whole SKILL.md, body included, in a parse pool of its own.
 * This pins that lane as it is (known-defects.md, "`vat inventory` of one SKILL.md parses its whole
 * body"): the answer is right, the frontmatter block is parsed once on the caller's dispatcher,
 * and the fallback's registry parses the whole text once more. When the defect is fixed, the
 * second parse goes and this test reds; update it to the block alone then.
 *
 * Integration tier: the wide skill is megabytes, parsed whole in a worker pool.
 */

import * as fs from 'node:fs/promises';

import { ParseCache, ParseDispatcher } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { extractClaudeSkillInventory, NO_GIT_TRACKER } from '../../src/inventory/extract-skill.js';
import { SKILLS, WIDE_BLOCK, WIDE_TEXT, setupRefusedSkillFixture, wideSkill, writeSkill } from '../refused-skill-fixture.js';

describe('vat inventory of one SKILL.md, whose walk has no population', () => {
  const getFixture = setupRefusedSkillFixture('vat-skill-md-fallback-');
  let wide: string;
  let dispatcher: ParseDispatcher;

  beforeAll(async () => {
    wide = await writeSkill(safePath.join(getFixture().pluginDir, SKILLS, 'wide'), '');
    await fs.writeFile(wide, wideSkill());
    dispatcher = new ParseDispatcher(new ParseCache({ enabled: false }), {});
  });

  afterAll(async () => {
    await dispatcher.shutdown();
  });

  it('declares its name, and the fallback registry parses the whole text once more', async () => {
    // Every dispatcher's parse, the fallback registry's own included: it is called on this thread.
    const parse = vi.spyOn(ParseDispatcher.prototype, 'parse');
    try {
      const inventory = await extractClaudeSkillInventory(wide, { dispatcher, gitTrackerSource: NO_GIT_TRACKER });

      expect(inventory.parseErrors).toEqual([]);
      expect(inventory.manifest.name).toBe('wide');
      const lengths = parse.mock.calls.map(([keyed]) => keyed.content.length).sort((a, b) => a - b);
      expect(lengths).toEqual([WIDE_BLOCK, WIDE_TEXT.length]);
    } finally {
      parse.mockRestore();
    }
  });
});
