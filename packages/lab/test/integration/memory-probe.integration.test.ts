/**
 * The `memory` facet's RSS probe, run the only way it ever runs: `--require`d
 * into a real node child. The tests run the BUILT `dist/facets/memory/rss-probe.cjs`,
 * because the emitted file is the artifact that ships.
 *
 * Each size assertion is a lower bound set by an allocation the child makes, so
 * a probe that read the wrong figure (heap instead of RSS, the launcher instead
 * of the worker's process, bytes read as kilobytes would overshoot but never
 * undershoot) fails as a number below the allocation.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterAll, describe, expect, it } from 'vitest';

import { RssDumpSchema } from '../../src/facets/memory/types.js';

/** The emitted probe. */
const PROBE_DIST = toForwardSlash(fileURLToPath(new URL('../../dist/facets/memory/rss-probe.cjs', import.meta.url)));

/** The activation variable `capture.ts` sets — pinned against the probe's own below. */
const LOG_DIR_ENV = 'VAT_LAB_RSS_LOG';

/** Kilobytes in a mebibyte. */
const MIB_KB = 1024;

const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/**
 * Run a script in a child with the probe preloaded.
 *
 * @param script - Source passed to `node -e`
 * @param logDir - The dump directory, or `undefined` to leave the probe inert
 * @returns The dump files' parsed contents, and the directory they were read from
 */
function runWithProbe(script: string, logDir: string | undefined): { dumps: unknown[]; dir: string } {
  const dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'lab-rss-probe-'));
  scratch.push(dir);
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: `--require "${PROBE_DIST}"` };
  delete env[LOG_DIR_ENV];
  if (logDir !== undefined) env[LOG_DIR_ENV] = logDir === '' ? dir : logDir;
  const result = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf-8' });
  expect(result.status, result.stderr).toBe(0);
  const dumps = readdirSync(dir).map((name) => JSON.parse(readFileSync(safePath.join(dir, name), 'utf-8')) as unknown);
  return { dumps, dir };
}

/**
 * Source that allocates and fills N MiB, so the pages are resident rather than merely reserved.
 *
 * @param mib - How much
 * @returns A script fragment
 */
function allocate(mib: number): string {
  return `globalThis.kept = Buffer.alloc(${String(mib)} * 1024 * 1024, 1);`;
}

describe('the RSS probe', () => {
  it('writes one schema-valid dump whose peak covers what the process allocated', () => {
    const { dumps } = runWithProbe(allocate(200), '');

    expect(dumps).toHaveLength(1);
    const dump = RssDumpSchema.parse(dumps[0]);
    expect(dump.maxRssKb).toBeGreaterThan(200 * MIB_KB);
  });

  it('counts a worker thread\'s memory in its process, and writes no second dump for the worker', () => {
    // The main thread allocates nothing; only the worker does. A probe that
    // missed workers reports the ~50 MiB of a bare node; one that let the worker
    // dump too writes two files.
    const workerSource = JSON.stringify(allocate(300) + ' setTimeout(() => {}, 50);');
    const script =
      "const { Worker } = require('node:worker_threads');" +
      `new Worker(${workerSource}, { eval: true });`;
    const { dumps } = runWithProbe(script, '');

    expect(dumps).toHaveLength(1);
    expect(RssDumpSchema.parse(dumps[0]).maxRssKb).toBeGreaterThan(300 * MIB_KB);
  });

  it('is inert without its variable', () => {
    expect(runWithProbe(allocate(1), undefined).dumps).toEqual([]);
  });

  it('activates on exactly the variable the capture sets', () => {
    const probe = createRequire(import.meta.url)(PROBE_DIST) as { __internals: { LOG_DIR_ENV: string } };

    expect(probe.__internals.LOG_DIR_ENV).toBe(LOG_DIR_ENV);
  });

  it('requires nothing but node builtins — it runs inside an npx vat with nothing of the lab installed', () => {
    const source = readFileSync(PROBE_DIST, 'utf-8').replaceAll(/\/\*[\S\s]*?\*\//g, '');
    const required = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((match) => match[1]);

    expect(required.length).toBeGreaterThan(0);
    expect(required.filter((name) => name?.startsWith('node:') !== true)).toEqual([]);
  });
});
