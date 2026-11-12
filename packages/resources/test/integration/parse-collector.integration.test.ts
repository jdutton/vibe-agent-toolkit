/**
 * A parse thread takes its collector under V8's process-wide `--expose-gc`, and clears the flag
 * again: no context the host creates afterwards has a `gc`, and the code-cache tag is unchanged.
 * Set, acquire and clear run under the pool's lock, so threads started at once never clear it from
 * under one another. Each case runs in a child process, because the flag is process-wide.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

const BUILT_POOL = pathToFileURL(safePath.resolve(import.meta.dirname, '..', '..', 'dist', 'parse-pool.js')).href;
const BUILT_COLLECTOR = pathToFileURL(safePath.resolve(import.meta.dirname, '..', '..', 'dist', 'parse-collector.js')).href;

/**
 * Run `script` as an ES module in a child process with no `NODE_OPTIONS`, and read the JSON line it prints.
 *
 * @param script - The module's source
 * @returns What it printed, parsed
 */
function runChild(script: string): Record<string, unknown> {
  const directory = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-collector-'));
  const entry = safePath.join(directory, 'collector.mjs');
  writeFileSync(entry, script, 'utf-8');
  const env = { ...process.env };
  delete env['NODE_OPTIONS'];
  const child = spawnSync(process.execPath, [entry], { env, encoding: 'utf-8' });
  rmSync(directory, { recursive: true, force: true });

  expect(child.stderr).toBe('');
  expect(child.status).toBe(0);
  return JSON.parse(child.stdout) as Record<string, unknown>;
}

describe('a parse thread\'s collector', () => {
  it('leaves no `gc` in a context the host creates after the pool ran, and the code-cache tag as it was', () => {
    const outcome = runChild([
      "import v8 from 'node:v8';",
      "import vm from 'node:vm';",
      `const { createParsePool } = await import(${JSON.stringify(BUILT_POOL)});`,
      'const tag = v8.cachedDataVersionTag();',
      'const pool = createParsePool({ size: 4 });',
      String.raw`await Promise.all(Array.from({ length: 8 }, (_, i) => pool.parse('markdown', '# ' + i + '\n', 4)));`,
      'await pool.shutdown();',
      "console.log(JSON.stringify({ sameTag: v8.cachedDataVersionTag() === tag, hostContextGc: vm.runInNewContext('typeof gc') }));",
    ].join('\n'));

    expect(outcome).toStrictEqual({ sameTag: true, hostContextGc: 'undefined' });
  });

  it('is had by every one of 16 threads started at once, over five rounds, under the shared lock', () => {
    const workerBody = [
      `const { acquireCollector } = await import(${JSON.stringify(BUILT_COLLECTOR)});`,
      "const { parentPort, workerData } = await import('node:worker_threads');",
      "parentPort.postMessage(acquireCollector(new Int32Array(workerData.lock), 2000) === null ? 'none' : 'collector');",
    ].join('\n');
    const outcome = runChild([
      "import { Worker } from 'node:worker_threads';",
      'const lock = new SharedArrayBuffer(4);',
      `const body = ${JSON.stringify(workerBody)};`,
      'const tally = { collector: 0, none: 0 };',
      'for (let round = 0; round < 5; round++) {',
      '  const answers = await Promise.all(Array.from({ length: 16 }, () => new Promise((resolve) => {',
      "    const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(body)), { workerData: { lock } });",
      "    worker.once('message', (answer) => { resolve(answer); void worker.terminate(); });",
      '  })));',
      '  for (const answer of answers) tally[answer] += 1;',
      '}',
      'console.log(JSON.stringify(tally));',
    ].join('\n'));

    expect(outcome).toStrictEqual({ collector: 80, none: 0 });
  });

  it('takes the lock from a holder that kept it past its stale time, and frees it and the flag after', () => {
    const outcome = runChild([
      "import vm from 'node:vm';",
      `const { acquireCollector } = await import(${JSON.stringify(BUILT_COLLECTOR)});`,
      'const lock = new Int32Array(new SharedArrayBuffer(4));',
      '// A holder that died holding it: never released.',
      'lock[0] = 424242;',
      'const collect = acquireCollector(lock, 50);',
      "console.log(JSON.stringify({ collector: typeof collect, lock: lock[0], contextGc: vm.runInNewContext('typeof gc') }));",
    ].join('\n'));

    expect(outcome).toStrictEqual({ collector: 'function', lock: 0, contextGc: 'undefined' });
  });
});
