/**
 * Frontmatter is decoded only in the parse worker, under its limits (ADR I6, I8).
 *
 * The oracle is depth. `yaml` recurses once per nesting level, and the main
 * thread's stack gives out near 1,000 levels of `a: [[[…]]]` while a worker's
 * 4 MiB stack does not. So:
 *
 * - at 999 levels (1,000 as JSON, the mapping included — the deepest SQLite
 *   reads) the mapping must come back identical on a cold run, a warm
 *   (cache-hit) run and a second cold run, with no `frontmatterError` — which
 *   holds only if the PARENT never decodes the YAML, on either path;
 * - one level deeper, and at 2,000, the frontmatter is an `outputDepth` breach
 *   naming the depth it found, with nothing stored; a cyclic anchor, whose
 *   depth has no end, is the same breach;
 * - a root that decodes to no plain mapping (`!!set`, `!!omap`, `!!timestamp`,
 *   `!!binary`) is admitted as not a mapping, and the parent's decode never
 *   throws on it;
 * - at 20,000 levels under an explicit 1 MiB `stackMb`, the worker's own stack
 *   gives out, and that is a `stackMb` limit refusal with nothing stored —
 *   never a `frontmatterError` a cache would serve as a fact of the bytes.
 */

import { writeFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isParsableContent, readContentWithKey, type ParsableContent } from '../../src/content-key.js';
import type { ParseResult } from '../../src/link-parser.js';
import { ParseCache } from '../../src/parse-cache.js';
import { ParseDispatcher, type ParsePoolPolicy } from '../../src/parse-dispatcher.js';
import { isParseLimitError, type ParseLimitError } from '../../src/parse-limits.js';
import { countFilesUnder, setupSubdirTestSuite } from '../test-helpers.js';

const suite = setupSubdirTestSuite('vat-frontmatter-depth-');

/**
 * @param depth - Nesting levels of the flow sequence under `a`
 * @returns A markdown document whose frontmatter nests that deep
 */
function deepFrontmatter(depth: number): string {
  return `---\na: ${'['.repeat(depth)}${']'.repeat(depth)}\n---\n\n# Body\n`;
}

/**
 * @param value - The decoded `a`
 * @returns How many arrays deep it goes
 */
function depthOf(value: unknown): number {
  let depth = 0;
  let cursor = value;
  while (Array.isArray(cursor)) {
    depth += 1;
    cursor = cursor[0];
  }
  return depth;
}

async function keyedDocument(name: string, content: string): Promise<ParsableContent> {
  const path = safePath.join(suite.tempDir, name);
  await writeFile(path, content, 'utf-8');
  const keyed = await readContentWithKey(path, 'markdown');
  if (!isParsableContent(keyed)) throw new Error('a markdown document routed to no parser');
  return keyed;
}

/** One run: a fresh dispatcher over `cache`, shut down after its one parse. */
async function oneRun(cache: ParseCache, keyed: ParsableContent, policy: ParsePoolPolicy = {}): Promise<ParseResult> {
  const dispatcher = new ParseDispatcher(cache, policy);
  try {
    return await dispatcher.parse(keyed);
  } finally {
    await dispatcher.shutdown();
  }
}

/** The refusal a run ended in, or an error saying it answered. */
async function refusalOf(cache: ParseCache, keyed: ParsableContent, policy: ParsePoolPolicy = {}): Promise<unknown> {
  return oneRun(cache, keyed, policy).then(
    (result) => new Error(`the parse answered, frontmatterError: ${String(result.frontmatterError)}`),
    (rejection: unknown) => rejection,
  );
}

describe('frontmatter nested past the main thread stack', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  it('parses identically cold, warm and cold again at 999 levels, with no frontmatterError', async () => {
    const keyed = await keyedDocument('deep.md', deepFrontmatter(999));
    const cache = new ParseCache({ cacheDir: safePath.join(suite.tempDir, 'cache-a'), enabled: true });

    const cold = await oneRun(cache, keyed);
    const warm = await oneRun(cache, keyed);
    expect(cache.stats.hits).toBe(1);
    const coldAgain = await oneRun(
      new ParseCache({ cacheDir: safePath.join(suite.tempDir, 'cache-b'), enabled: true }),
      keyed,
    );

    for (const result of [cold, warm, coldAgain]) {
      expect(result.frontmatterError).toBeUndefined();
      expect(depthOf(result.frontmatter?.['a'])).toBe(999);
    }
    expect(warm).toStrictEqual(cold);
    expect(coldAgain).toStrictEqual(cold);
  });

  it('refuses 20,000 levels at a 1 MiB stack limit and stores nothing', async () => {
    // The stack is named, never left at its default: the refusal must come from
    // the limit this test sets. 1 MiB gives out near 1,000 levels (the main
    // thread's own default does), so 20,000 is far past it at any frame size.
    const keyed = await keyedDocument('deeper.md', deepFrontmatter(20_000));
    const cacheDir = safePath.join(suite.tempDir, 'cache');
    const cache = new ParseCache({ cacheDir, enabled: true });

    const error = await refusalOf(cache, keyed, { limits: { stackMb: 1 } });

    expect(isParseLimitError(error) ? error.limit : error).toBe('stackMb');
    expect(await countFilesUnder(cacheDir)).toBe(0);
  });

  it.each([
    [1000, '1000 levels of nesting; this document nests 1001'],
    [2000, '1000 levels of nesting; this document nests 2001'],
  ])('refuses %i levels, deeper as JSON than SQLite reads, naming the depth, and stores nothing', async (levels, bound) => {
    const keyed = await keyedDocument(`depth-${String(levels)}.md`, deepFrontmatter(levels));
    const cacheDir = safePath.join(suite.tempDir, `cache-${String(levels)}`);

    const error = await refusalOf(new ParseCache({ cacheDir, enabled: true }), keyed);

    expect(isParseLimitError(error) ? { limit: error.limit, bound: error.bound } : error).toStrictEqual({ limit: 'outputDepth', bound });
    expect(await countFilesUnder(cacheDir)).toBe(0);
  });

  it('refuses a cyclic anchor as nesting without end, and stores nothing', async () => {
    const keyed = await keyedDocument('cyclic.md', '---\na: &x [*x]\ntitle: t\n---\n\n# Body\n');
    const cacheDir = safePath.join(suite.tempDir, 'cache-cyclic');

    const error = await refusalOf(new ParseCache({ cacheDir, enabled: true }), keyed);

    expect(isParseLimitError(error) ? error.limit : error).toBe('outputDepth');
    expect((error as ParseLimitError).bound).toContain('without end');
    expect(await countFilesUnder(cacheDir)).toBe(0);
  });

  it.each([
    ['!!set', '!!set\n? a\n? b'],
    ['!!omap', '!!omap\n- a: 1\n- b: 2'],
    ['!!timestamp', '!!timestamp 2024-01-01'],
    ['!!binary', '!!binary aGk='],
  ])('admits a %s root as not a mapping, cold and warm, with no decode defect', async (label, source) => {
    const keyed = await keyedDocument(`root-${label.slice(2)}.md`, `---\n${source}\n---\n\n# Body\n`);
    const cache = new ParseCache({ cacheDir: safePath.join(suite.tempDir, `cache-root-${label.slice(2)}`), enabled: true });

    const cold = await oneRun(cache, keyed);
    const warm = await oneRun(cache, keyed);

    expect(cold.frontmatterNotAMapping).toBe(true);
    expect(cold.frontmatter).toBeUndefined();
    expect(warm).toStrictEqual(cold);
  });
});
