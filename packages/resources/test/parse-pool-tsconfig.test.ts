/**
 * The `tsconfig` job on the parse pool, through the real built worker: it answers exactly what the
 * job computes in-process, the vendored TypeScript loading in the worker, and a config nested to
 * `outputDepth` parses there (TypeScript's JSON reader recurses; the worker's stack holds it).
 */

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PARSE_LIMITS } from '../src/parse-limits.js';
import { parseTsconfigs, type TsconfigJobInput } from '../src/projection/tsconfig-parse.js';
import { loadVendoredTypeScript } from '../src/vendored-typescript.js';

import { limitedPools, TIGHT_LIMITS } from './parse-limit-fixtures.js';

const limitedPool = limitedPools();

/** An absolute root no disk holds: the job reads nothing from it. */
const ROOT = safePath.join(normalizedTmpdir(), 'vat-tsconfig-pool-fixture-root-never-created');

describe('a tsconfig parse on the parse pool', () => {
  it('answers exactly what the job computes in-process', async () => {
    const input: TsconfigJobInput = {
      root: ROOT,
      configs: ['pkg/tsconfig.json', 'tsconfig.json'],
      texts: {
        'pkg/tsconfig.json': JSON.stringify({ extends: '../base.json', include: ['src'], references: [{ path: '..' }] }),
        'base.json': JSON.stringify({ compilerOptions: { outDir: '${configDir}/dist', strict: true } }),
        'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './pkg' }] }),
      },
      listing: ['tsconfig.json', 'base.json', 'pkg/tsconfig.json', 'pkg/src/a.ts', 'pkg/dist/a.js'],
      useCaseSensitiveFileNames: true,
    };
    const inProcess = parseTsconfigs(await loadVendoredTypeScript(), input, TIGHT_LIMITS);
    expect(inProcess.outcome).toBe('parsed');
    await expect(limitedPool().tsconfig(input)).resolves.toStrictEqual(inProcess);
  });

  it('parses a config nested to outputDepth, in objects and in arrays, in a worker at the default stack', async () => {
    // At the tight fixture's 1 MiB stack TypeScript's reader overflows on this depth (a `stackMb`
    // refusal); the default stack is the one a run gets.
    const pool = limitedPool({ stackMb: DEFAULT_PARSE_LIMITS.stackMb, outputDepth: DEFAULT_PARSE_LIMITS.outputDepth });
    const listing = ['tsconfig.json', 'a.ts'];
    for (const wrap of [(inner: unknown) => ({ a: inner }), (inner: unknown) => [inner]]) {
      let nested: unknown = 'x';
      for (let level = 0; level < DEFAULT_PARSE_LIMITS.outputDepth - 1; level += 1) nested = wrap(nested);
      const texts = { 'tsconfig.json': JSON.stringify({ files: ['a.ts'], deep: nested }) };
      await expect(pool.tsconfig({ root: ROOT, configs: ['tsconfig.json'], texts, listing }))
        .resolves.toMatchObject({ outcome: 'parsed', configs: [{ path: 'tsconfig.json', fileNames: ['a.ts'], errors: [] }] });
    }
  });

  it('answers a miss as a request', async () => {
    await expect(limitedPool().tsconfig({ root: ROOT, configs: ['tsconfig.json'], texts: {}, listing: ['tsconfig.json'] }))
      .resolves.toMatchObject({ outcome: 'requests', requests: ['tsconfig.json'] });
  });
});
