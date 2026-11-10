/**
 * Every parse job is stopped at its limit, and the pool survives it (I8).
 *
 * Each breach is driven by a real document through the real built worker — see
 * `parse-limit-fixtures.ts` — and each test asserts three things: the job
 * rejects with a {@link ParseLimitError} naming the limit it crossed, it does so
 * near that bound rather than whenever the document would have finished, and the
 * SAME pool then parses an ordinary document, so a breach costs one job and never
 * the pool.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { type ParseLimitName, type ParseLimits, isParseLimitError } from '../../src/parse-limits.js';
import { createParsePool, type ParsePool } from '../../src/parse-pool.js';
import {
  deeplyNestedList,
  deeplyNestedQuote,
  manyLinks,
  TIGHT_LIMITS,
} from '../parse-limit-fixtures.js';
import { workerThreadCount } from '../test-helpers.js';

const openPools: ParsePool[] = [];

afterEach(async () => {
  await Promise.all(openPools.splice(0, openPools.length).map(async (pool) => pool.shutdown()));
});

function limitedPool(limits: Partial<ParseLimits> = {}): ParsePool {
  const pool = createParsePool({ size: 1, limits: { ...TIGHT_LIMITS, ...limits } });
  openPools.push(pool);
  return pool;
}

/**
 * Parse `content` and return the limit it was stopped at, failing if it was not.
 *
 * @returns The limit's name and how long the rejection took
 */
async function breach(pool: ParsePool, content: string): Promise<{ limit: ParseLimitName; ms: number }> {
  const startedAt = performance.now();
  const error: unknown = await pool.parse('markdown', content, Buffer.byteLength(content)).then(
    () => new Error('the parse completed; it was meant to be stopped at a limit'),
    (rejection: unknown) => rejection,
  );
  const ms = performance.now() - startedAt;
  if (!isParseLimitError(error)) throw error;
  return { limit: error.limit, ms };
}

/** The pool still answers an ordinary document after a breach. */
async function expectPoolStillParses(pool: ParsePool): Promise<void> {
  const result = await pool.parse('markdown', '# ok\n\n[a](./b.md)\n', 21);
  expect(result.links).toHaveLength(1);
}

describe('a parse job stopped at its limit', () => {
  it('kills a job that runs past its wall-clock limit, and replaces the worker', async () => {
    // A heap roomy enough that the clock, not the heap, is what the nesting meets first.
    const pool = limitedPool({ heapMb: 1024 });

    const { limit, ms } = await breach(pool, deeplyNestedList());

    expect(limit).toBe('timeMs');
    // Near the bound, not when the parse would have finished (seconds later).
    expect(ms).toBeLessThan(TIGHT_LIMITS.timeMs + 5000);
    await expectPoolStillParses(pool);
  });

  it('stops a job that recurses past its stack', async () => {
    // The wall clock includes the worker's first parser load, which on a cold
    // thread can outlast the tight bound before the recursion is ever reached.
    // A heap roomy enough that the stack, not the heap, is what the recursion meets first.
    const pool = limitedPool({ timeMs: 30_000, heapMb: 512 });

    const { limit } = await breach(pool, deeplyNestedQuote());

    expect(limit).toBe('stackMb');
    await expectPoolStillParses(pool);
  });

  it('kills a job whose allocation outgrows its heap, and replaces the worker', async () => {
    const pool = limitedPool({ timeMs: 60_000, outputRows: 10_000_000, outputBytes: 1024 * 1024 * 1024 });

    const { limit } = await breach(pool, manyLinks(200_000));

    expect(limit).toBe('heapMb');
    await expectPoolStillParses(pool);
  });

  it('refuses an oversize document without handing it to a worker', async () => {
    const before = workerThreadCount();
    const pool = limitedPool({ inputBytes: 1024 });

    const { limit } = await breach(pool, 'x'.repeat(2048));

    expect(limit).toBe('inputBytes');
    expect(workerThreadCount()).toBe(before);
  });

  it('stops a job whose output has more rows than its cap', async () => {
    const pool = limitedPool({ outputRows: 10 });

    const { limit } = await breach(pool, manyLinks(20));

    expect(limit).toBe('outputRows');
    await expectPoolStillParses(pool);
  });

  it('stops a job whose output serialises past its byte cap', async () => {
    const pool = limitedPool({ outputBytes: 512 });

    const { limit } = await breach(pool, manyLinks(20));

    expect(limit).toBe('outputBytes');
    await expectPoolStillParses(pool);
  });

  it('answers the other jobs in flight beside a breach', async () => {
    const pool = createParsePool({ size: 2, limits: { ...TIGHT_LIMITS, heapMb: 512 } });
    openPools.push(pool);

    const [stopped, answered] = await Promise.allSettled([
      pool.parse('markdown', deeplyNestedQuote(), 1),
      pool.parse('markdown', '[a](./b.md)\n', 12),
    ]);

    expect(stopped.status === 'rejected' && isParseLimitError(stopped.reason)).toBe(true);
    expect(answered.status === 'fulfilled' ? answered.value.links : []).toHaveLength(1);
  });
});

/**
 * The BUILT pool, as a child process imports it — so the child's own heap flags
 * are the ones under test, never the test runner's.
 */
const BUILT_POOL = pathToFileURL(safePath.resolve(import.meta.dirname, '..', '..', 'dist', 'parse-pool.js')).href;

describe('a process-wide heap flag', () => {
  it('cannot lift a job\'s heap limit', () => {
    // A process-wide `--max-old-space-size` (NODE_OPTIONS, common in CI) is a V8
    // global flag, and it overrides a worker's `resourceLimits`: measured, under
    // 4096 a worker given 48 MiB reports a 4,192 MiB heap limit and a runaway
    // allocation runs until the wall clock stops it. The job must still be
    // stopped at its HEAP limit, well before its wall-clock one.
    const script = [
      `const { createParsePool } = await import(${JSON.stringify(BUILT_POOL)});`,
      String.raw`const doc = Array.from({ length: 200000 }, (_, i) => '[link ' + i + '](./t-' + i + '.md)\n').join('\n');`,
      'const pool = createParsePool({ size: 1, limits: { heapMb: 48, timeMs: 60000, outputRows: 1e9, outputBytes: 1e10, inputBytes: 1e9 } });',
      'const startedAt = performance.now();',
      "const limit = await pool.parse('markdown', doc, doc.length).then(() => 'none', (error) => error.limit ?? String(error));",
      'console.log(JSON.stringify({ limit, ms: performance.now() - startedAt }));',
      'await pool.shutdown();',
    ].join('\n');
    // A script FILE, not `--eval`: a worker inherits its parent's execArgv,
    // and `--input-type` is refused by a worker started from a file.
    const directory = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-heap-flag-'));
    const entry = safePath.join(directory, 'heap-flag.mjs');
    writeFileSync(entry, script, 'utf-8');
    const child = spawnSync(process.execPath, [entry], {
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' },
      encoding: 'utf-8',
    });
    rmSync(directory, { recursive: true, force: true });

    expect(child.stderr).toBe('');
    const outcome = JSON.parse(child.stdout) as { limit: string; ms: number };
    expect(outcome.limit).toBe('heapMb');
    expect(outcome.ms).toBeLessThan(30_000);
  });
});
