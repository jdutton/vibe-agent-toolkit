/**
 * Frontmatter is decoded only in the parse worker, under its limits (ADR I6, I8).
 *
 * The oracle is depth. `yaml` recurses once per nesting level, and the main
 * thread's stack gives out near 1,000 levels of `a: [[[…]]]` while a worker's
 * 4 MiB stack does not. So:
 *
 * - at 1,000 levels the mapping must come back identical on a cold run, a warm
 *   (cache-hit) run and a second cold run, with no `frontmatterError` — which
 *   holds only if the PARENT never decodes the YAML, on either path;
 * - at 4,000 levels the worker's own stack gives out, and that is a `stackMb`
 *   limit refusal with nothing stored — never a `frontmatterError` a cache
 *   would serve as a fact of the bytes.
 */

import { writeFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isParsableContent, readContentWithKey, type ParsableContent } from '../../src/content-key.js';
import type { ParseResult } from '../../src/link-parser.js';
import { ParseCache } from '../../src/parse-cache.js';
import { ParseDispatcher } from '../../src/parse-dispatcher.js';
import { isParseLimitError } from '../../src/parse-limits.js';
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
async function oneRun(cache: ParseCache, keyed: ParsableContent): Promise<ParseResult> {
  const dispatcher = new ParseDispatcher(cache, {});
  try {
    return await dispatcher.parse(keyed);
  } finally {
    await dispatcher.shutdown();
  }
}

describe('frontmatter nested past the main thread stack', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  it('parses identically cold, warm and cold again at 1,000 levels, with no frontmatterError', async () => {
    const keyed = await keyedDocument('deep.md', deepFrontmatter(1000));
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
      expect(depthOf(result.frontmatter?.['a'])).toBe(1000);
    }
    expect(warm).toStrictEqual(cold);
    expect(coldAgain).toStrictEqual(cold);
  });

  it('refuses 4,000 levels at the stack limit and stores nothing', async () => {
    const keyed = await keyedDocument('deeper.md', deepFrontmatter(4000));
    const cacheDir = safePath.join(suite.tempDir, 'cache');
    const cache = new ParseCache({ cacheDir, enabled: true });

    const error: unknown = await oneRun(cache, keyed).then(
      (result) => new Error(`the parse answered, frontmatterError: ${String(result.frontmatterError)}`),
      (rejection: unknown) => rejection,
    );

    expect(isParseLimitError(error) ? error.limit : error).toBe('stackMb');
    expect(await countFilesUnder(cacheDir)).toBe(0);
  });
});
