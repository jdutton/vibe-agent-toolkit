/**
 * One frontmatter shape rule, two lanes. The crawl lane decodes a block with
 * `parseFrontmatterSource` (via `parseMarkdown`); the skill lane with
 * `parseFrontmatter`. For the same block they must give the same answer:
 *
 * - a root that is not a PLAIN mapping (a sequence, a scalar, or the typed
 *   value of a `!!set` / `!!omap` / `!!timestamp` / `!!binary` root) is "not a
 *   mapping" on both — the crawl lane flags `frontmatterNotAMapping`, the skill
 *   lane refuses;
 * - a block that declares nothing (empty, `~`, `null`, comment-only) is no
 *   frontmatter on both and a non-mapping on neither — no flag and no
 *   `frontmatter` on the crawl lane, a refusal that says "empty" on the skill
 *   lane.
 *
 * Before the skill lane read `isPlainMapping`, it admitted every typed root as
 * a `Record<string, unknown>` with no keys, and called an empty block "not a
 * YAML mapping" where the crawl lane says it declares nothing.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { parseMarkdown } from '@vibe-agent-toolkit/resources';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseFrontmatter } from '../../src/parsers/frontmatter-parser.js';

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-fm-lanes-'));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * Both lanes' answer for one block.
 *
 * @param name - A file name for the block
 * @param block - The YAML between the delimiters
 * @returns The crawl lane's and the skill lane's verdicts
 */
async function bothLanes(name: string, block: string): Promise<{ crawl: unknown; skill: unknown }> {
  const content = `---\n${block}\n---\n# Body\n`;
  const file = safePath.join(scratch, `${name}.md`);
  writeFileSync(file, content, 'utf-8');
  const crawled = await parseMarkdown(file);
  const skill = parseFrontmatter(content);
  return {
    crawl: { notAMapping: crawled.frontmatterNotAMapping === true, keys: crawled.frontmatter === undefined ? null : Object.keys(crawled.frontmatter) },
    skill: skill.success
      ? { notAMapping: false, keys: Object.keys(skill.frontmatter) }
      : { notAMapping: skill.error.includes('not a YAML mapping'), keys: null },
  };
}

describe('the crawl lane and the skill lane read one frontmatter shape rule', () => {
  it.each([
    ['set', '!!set\n? a\n? b'],
    ['omap', '!!omap\n- a: 1\n- b: 2'],
    ['timestamp', '!!timestamp 2024-01-01'],
    ['binary', '!!binary aGk='],
    ['sequence', '- a\n- b'],
    ['scalar', 'hello'],
  ])('a %s root is not a mapping on both lanes', async (name, block) => {
    const { crawl, skill } = await bothLanes(name, block);
    expect(crawl).toStrictEqual({ notAMapping: true, keys: null });
    expect(skill).toStrictEqual(crawl);
  });

  it.each([
    ['tilde', '~'],
    ['null', 'null'],
    ['comment', '# nothing yet'],
    ['blank', ''],
  ])('a %s block is no frontmatter on both lanes, and neither calls it a non-mapping', async (name, block) => {
    const { crawl, skill } = await bothLanes(name, block);
    expect(crawl).toStrictEqual({ notAMapping: false, keys: null });
    expect(skill).toStrictEqual(crawl);
  });

  it('a mapping is the same keys on both lanes', async () => {
    const { crawl, skill } = await bothLanes('mapping', 'name: x\ndescription: y');
    expect(crawl).toStrictEqual({ notAMapping: false, keys: ['name', 'description'] });
    expect(skill).toStrictEqual(crawl);
  });
});
