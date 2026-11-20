/**
 * A walk too large for an argument list: a gitignored `.venv` holds 200,000
 * paths, and the stored population appends its walk of ignored territory to
 * the candidates. Appended as a spread (`push(...walked)`), that is one
 * argument per path, and past the engine's argument limit the run dies with
 * `Maximum call stack size exceeded`.
 *
 * The walk is mocked rather than planted: writing the files would cost the
 * suite seconds to prove a property of one line. Its size is measured in THIS
 * worker at runtime, never a literal, because the limit differs between the
 * main thread and a vitest worker.
 */
import { rmSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import type * as CrawlModule from '@vibe-agent-toolkit/utils/crawl';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCommittedRepo, writeFileIn } from '../test-helpers.js';

/** The walk results by directory, which the mocked walk hands back in place of a real one. */
const planted = new Map<string, string[]>();

vi.mock('@vibe-agent-toolkit/utils/crawl', async (importOriginal) => {
  const original = await importOriginal<typeof CrawlModule>();
  return {
    ...original,
    crawlDirectory: vi.fn(async (options: Parameters<typeof original.crawlDirectory>[0]) =>
      planted.get(options.baseDir) ?? original.crawlDirectory(options)),
  };
});

const { GitCrawlSource } = await import('../../src/projection/crawl-source.js');

/** The smallest power of two this worker refuses as an argument list. */
function argumentLimitHere(): number {
  for (let size = 1 << 14; size <= 1 << 24; size *= 2) {
    try {
      Reflect.apply(Array.prototype.push, [], new Array<number>(size).fill(0));
    } catch (error) {
      // The engine's refusal of an argument list this long; anything else is a bug.
      if (error instanceof RangeError) return size;
      throw error;
    }
  }
  throw new Error('no argument limit below 2^24 in this worker');
}

let root: string | undefined;
afterEach(() => {
  planted.clear();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('a walk of ignored territory larger than an argument list', () => {
  it('is appended to the candidates, never refused by the call stack', async () => {
    root = createCommittedRepo('vat-crawl-large-walk-', { files: { 'README.md': '# Home\n' }, gitignore: '.venv/\n' });
    writeFileIn(root, '.venv/lib/site.py', 'x = 1\n');
    const venv = safePath.join(root, '.venv');
    const size = argumentLimitHere();
    planted.set(venv, Array.from({ length: size }, (_, index) => safePath.join(venv, 'lib', `f${String(index)}.py`)));

    const source = new GitCrawlSource(root, []);
    const paths = (await source.enumerate()).map((entry) => entry.absolutePath);

    // Positive control: the walk was the planted one, so its size was in play.
    expect(paths).toContain(safePath.join(venv, 'lib', `f${String(size - 1)}.py`));
  });
});
