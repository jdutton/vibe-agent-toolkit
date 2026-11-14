/**
 * A process-wide V8 heap flag, on the command line or in NODE_OPTIONS, neither lifts a parse
 * job's heap limit nor lets V8 stop a worker before the pool does, and a parent thread that
 * stalls still stops a breach at the applied bound (I8). Every pool runs in a child process
 * started under the flag (`parse-pool-child.ts`), which must exit 0.
 */

import { describe, expect, it } from 'vitest';

import { MIN_HEAP_MB, workerHeapCeilingMb } from '../../src/parse-limits.js';

import { heapBreachUnder, onCommandLine, parseInChild, runInChild, UNTIL_THE_WORKER_IS_GONE } from './parse-pool-child.js';

describe('a process-wide heap flag', () => {
  it('cannot lift a job\'s heap limit', () => {
    // A process-wide `--max-old-space-size` (NODE_OPTIONS, common in CI) is a V8
    // global flag, and it overrides a worker's `resourceLimits`: measured, under
    // 4096 a worker given 48 MiB reports a 4,192 MiB heap limit and a runaway
    // allocation runs until the wall clock stops it. The job must still be
    // stopped at its HEAP limit, well before its wall-clock one. Through NODE_OPTIONS,
    // the route CI takes, which allows this flag on every platform.
    const outcome = heapBreachUnder({ execArgv: [], nodeOptions: '--max-old-space-size=4096' }, MIN_HEAP_MB, 0);

    expect(outcome.limit).toBe('heapMb');
    expect(outcome.bound).toBe(`${String(MIN_HEAP_MB)} MiB heap`);
    expect(outcome.ms).toBeLessThan(30_000);
  });

  it('is named in the refusal when it lowers the limit', () => {
    // Lower than `heapMb`, the flag caps V8's ceiling, and the pool stops the
    // job at half of it, so the refusal names that value, not the configured one.
    const outcome = heapBreachUnder(onCommandLine('--max-old-space-size=64'), 1024, 0);

    expect(outcome.limit).toBe('heapMb');
    expect(outcome.bound).toContain('32 MiB heap');
    expect(outcome.bound).toContain('--max-old-space-size');
  });

  it('still admits an ordinary document when it is small: 128 MiB, which the pool applies at its young-generation floor', () => {
    // The sampler counts the whole used heap, young-generation garbage
    // included, and a cold worker parsing this 34 KB document peaks at 54 to
    // 68 MiB used (Node 26, see the limits record). At half of a 128 MiB flag
    // (64) about one parse in ten was refused; the bound is floored at the
    // young generation (96 on Node 26) while the ceiling leaves the sampler 32 above it.
    const ordinary = String.raw`Array.from({ length: 400 }, (_, i) => '## Section ' + i + '\n\nProse with a [link](./doc-' + i + '.md), \x60code\x60 and *emphasis*.\n\n- item ' + i + '\n').join('\n')`;

    const outcome = parseInChild(onCommandLine('--max-old-space-size=128'), ordinary, '{}', 0);

    expect(outcome.limit, outcome.bound).toBe('none');
  });

  it('stops a breach at that floored bound before V8 does, three times in a row, and the process survives', () => {
    // The floor leaves 32 MiB between the bound and V8's ceiling, where half a
    // 128 MiB flag left 64: the sampler must still win the race V8 makes fatal.
    //
    // The floor is the young generation a thread really gets, which the runtime decides: 48 MiB on
    // Node 22 (so half the flag, 64, stands), 192 on Node 24 and 96 on Node 26 (so 96, the flag less
    // the headroom). It is measured here, in a child under the same flag, never assumed.
    // On Node 22 the floor branch is therefore inert (48 < 64) and this proves only the half share;
    // the floor itself is proven on the matrix Node, where it decides the bound.
    const flag = onCommandLine('--max-old-space-size=128');
    const youngMb = Number(runInChild(flag, [
      "import { Worker } from 'node:worker_threads';",
      `const worker = new Worker('', { eval: true, resourceLimits: { maxOldGenerationSizeMb: ${String(workerHeapCeilingMb(1024))} } });`,
      "worker.once('online', () => { console.log(worker.resourceLimits.maxYoungGenerationSizeMb); void worker.terminate(); });",
    ]).trim());
    expect(youngMb).toBeGreaterThan(0);
    const appliedMb = Math.max(128 / 2, Math.min(youngMb, 128 - 32));

    for (let attempt = 0; attempt < 3; attempt++) {
      const outcome = heapBreachUnder(flag, 1024, 0);

      expect(outcome.bound).toBe(`${String(appliedMb)} MiB heap, lowered from 1024 MiB by a process-wide V8 heap flag (--max-old-space-size, --max-heap-size or --max-semi-space-size)`);
    }
  });
});

describe('a heap breach while the parent thread stalls', () => {
  it('is still stopped at the applied limit when every stall is shorter than the window', () => {
    // The sampler runs on the parent's event loop, so a parent blocked
    // synchronously reads the worker's heap late. Under a 512 MiB flag the job
    // is stopped at 256 MiB, and V8's ceiling is 512: a sample up to about two
    // stalls late (400 ms back to back, so at most ~800 ms) still lands before
    // the worker reaches it. A stall length is a race, not a seam: 600 ms stalls
    // once let V8 stop the worker first (3 of 3 runs), and on a later run of the
    // same host the sampler won every time, so the V8-first case below holds the
    // thread until the worker is gone instead. See the hazard register's heap-flag row.
    const outcome = heapBreachUnder(onCommandLine('--max-old-space-size=512'), 1024, 400);

    expect(outcome.limit).toBe('heapMb');
    // Exactly the sampler's bound: a refusal V8 made would name its ceiling.
    expect(outcome.bound).toBe('256 MiB heap, lowered from 1024 MiB by a process-wide V8 heap flag (--max-old-space-size, --max-heap-size or --max-semi-space-size)');
  });

  it('names V8\'s ceiling, never the sampler\'s bound, when V8 stops the worker first — and the process survives', () => {
    // The child's thread is held from dispatch until the worker is gone, so no
    // heap sample lands and only V8's own ceiling (512 MiB) can stop the worker.
    // With no sample, the refusal says the ceiling is unknown (a process-wide
    // flag overrides it); never the 256 nobody stopped it at.
    const outcome = heapBreachUnder(onCommandLine('--max-old-space-size=512'), 1024, UNTIL_THE_WORKER_IS_GONE);

    expect(outcome.limit).toBe('heapMb');
    expect(outcome.bound).toMatch(/^V8's own heap ceiling, reached before the pool's heap sampler read it: .*, unless a process-wide V8 heap flag \(--max-old-space-size, --max-heap-size or --max-semi-space-size\) set it instead$/);
    expect(outcome.bound).not.toContain('256 MiB');
  });
});
