/**
 * One frontmatter rule, two lanes. The crawl lane decodes a block with
 * `parseFrontmatterSource` in the parse worker (via `parseFileCached`); the skill
 * lane with `parseFrontmatter`, which hands the block to the same worker. For the
 * same block they must give the same answer:
 *
 * - a root that is not a PLAIN mapping (a sequence, a scalar, or the typed
 *   value of a `!!set` / `!!omap` / `!!timestamp` / `!!binary` root) is "not a
 *   mapping" on both — the crawl lane flags `frontmatterNotAMapping`, the skill
 *   lane refuses;
 * - a block that declares nothing (empty, `~`, `null`, comment-only) is no
 *   frontmatter on both and a non-mapping on neither — no flag and no
 *   `frontmatter` on the crawl lane, a refusal that says "empty" on the skill
 *   lane;
 * - a block the worker refuses for this run (a cyclic anchor, nesting past
 *   `outputDepth`) is refused on both, under the same code — never decoded on
 *   the run's own thread, where it would overflow the stack or nest without end;
 * - where the block IS — the fence rule (`---` then optional spaces or tabs, on
 *   the first line only, closed by the next such line; CRLF, a lone CR and a BOM
 *   tolerated) — is the same on both, and so is what CommonMark does to the
 *   characters inside it (a NUL read back as U+FFFD), so neither lane crashes.
 *
 * Before the skill lane read `isPlainMapping`, it admitted every typed root as
 * a `Record<string, unknown>` with no keys, and called an empty block "not a
 * YAML mapping" where the crawl lane says it declares nothing.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { inMemoryContent, isPerRunParseRefusal, parseFileCached } from '@vibe-agent-toolkit/resources';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseFrontmatter } from '../../src/parsers/frontmatter-parser.js';
import { setupParseRoute } from '../test-helpers.js';

/** Both lanes parse in the bounded worker, on one dispatcher over a disabled cache. */
const ROUTE = setupParseRoute();

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-fm-lanes-'));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** One lane's verdict: refused for this run (and the code), or the shape it read. */
type Verdict = { refused: string } | { notAMapping: boolean; keys: string[] | null };

/** The refusal's code, for a per-run refusal; anything else is rethrown. */
function refusalCode(error: unknown): string {
  if (!isPerRunParseRefusal(error)) throw error;
  return String((error as { code: unknown }).code);
}

/** The crawl lane's verdict on one file. */
async function crawlVerdict(file: string): Promise<Verdict> {
  try {
    const crawled = await parseFileCached(file, 'markdown', ROUTE);
    return {
      notAMapping: crawled.frontmatterNotAMapping === true,
      keys: crawled.frontmatter === undefined ? null : Object.keys(crawled.frontmatter),
    };
  } catch (error) {
    return { refused: refusalCode(error) };
  }
}

/** The skill lane's verdict on the same bytes. */
async function skillVerdict(content: string): Promise<Verdict> {
  const skill = await parseFrontmatter(inMemoryContent(content), ROUTE);
  if (skill.success) return { notAMapping: false, keys: Object.keys(skill.frontmatter) };
  if (skill.cause !== undefined) return { refused: refusalCode(skill.cause) };
  return { notAMapping: skill.error.includes('not a YAML mapping'), keys: null };
}

/**
 * Both lanes' answer for one document.
 *
 * @param name - A file name for the document
 * @param content - The whole document
 * @returns The crawl lane's and the skill lane's verdicts
 */
async function bothLanesOn(name: string, content: string): Promise<{ crawl: Verdict; skill: Verdict }> {
  const file = safePath.join(scratch, `${name.replaceAll(/\W/g, '-')}.md`);
  writeFileSync(file, content, 'utf-8');
  return { crawl: await crawlVerdict(file), skill: await skillVerdict(content) };
}

/** Both lanes' answer for one block, fenced the plain way. */
function bothLanes(name: string, block: string): Promise<{ crawl: Verdict; skill: Verdict }> {
  return bothLanesOn(name, `---\n${block}\n---\n# Body\n`);
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

  it.each([
    ['cyclic anchor', 'a: &x [*x]'],
    ['1,001-deep nesting', `a: ${'['.repeat(1001)}${']'.repeat(1001)}`],
  ])('a %s block is refused on both lanes, under one code', async (name, block) => {
    const { crawl, skill } = await bothLanes(name, block);
    expect(crawl).toStrictEqual({ refused: 'PARSE_LIMIT_EXCEEDED' });
    expect(skill).toStrictEqual(crawl);
  });
});

describe('the crawl lane and the skill lane find the block by one fence rule', () => {
  const CR = String.fromCodePoint(0x0d);
  const BOM = String.fromCodePoint(0xfe_ff);
  const NUL = String.fromCodePoint(0);
  const REPLACEMENT = String.fromCodePoint(0xff_fd);
  const MAPPING = { notAMapping: false, keys: ['name'] };
  const NONE = { notAMapping: false, keys: null };

  it.each([
    ['plain', '---\nname: x\n---\n# Body\n', MAPPING],
    ['trailing spaces on the opener', '---  \nname: x\n---\n# Body\n', MAPPING],
    ['a trailing tab on the closer', '---\nname: x\n---\t\n# Body\n', MAPPING],
    ['no body', '---\nname: x\n---', MAPPING],
    ['CRLF line endings', `---${CR}\nname: x${CR}\n---${CR}\n# Body${CR}\n`, MAPPING],
    ['a leading BOM', `${BOM}---\nname: x\n---\n# Body\n`, MAPPING],
    ['lone CR line endings', `---${CR}name: x${CR}---${CR}# Body${CR}`, MAPPING],
    // CommonMark replaces U+0000 with U+FFFD before any extension sees it, so the
    // worker reads back a block that differs from the source by exactly that.
    ['a NUL in a value', `---\nname: a${NUL}b\n---\n# Body\n`, MAPPING],
    ['a NUL in a key', `---\nna${NUL}me: x\n---\n# Body\n`, { notAMapping: false, keys: [`na${REPLACEMENT}me`] }],
    ['CRLF with a NUL', `---${CR}\nname: a${NUL}b${CR}\n---${CR}\n# Body${CR}\n`, MAPPING],
    ['a BOM inside a value', `---\nname: a${BOM}b\n---\n# Body\n`, MAPPING],
    ['four dashes', '----\nname: x\n----\n# Body\n', NONE],
    ['dashes then text', '---x\nname: x\n---\n# Body\n', NONE],
    ['an indented closer', '---\nname: x\n ---\n# Body\n', NONE],
    ['a blank line before the opener', '\n---\nname: x\n---\n# Body\n', NONE],
    ['no closer', '---\nname: x\n# Body\n', NONE],
  ])('%s', async (name, content, expected) => {
    const { crawl, skill } = await bothLanesOn(`fence-${name}`, content);
    expect(crawl).toStrictEqual(expected);
    expect(skill).toStrictEqual(crawl);
  });
});
