/**
 * A command whose last work is a parse pool's shutdown finishes that shutdown.
 *
 * Shutdown parks a healthy idle thread for the next pool after reading its heap, and an idle
 * thread is `unref`'d. A heap read from an unref'd thread holds nothing open, so a process with
 * nothing else to do exited mid-shutdown, at code 0, with the rest of its run unrun: `vat audit`
 * printed half its report and succeeded. Only a real process shows it — inside vitest the
 * runner's own handles keep the loop alive — so the pool runs in a child, from the BUILT package
 * a command loads.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { NODE_EXECUTABLE, removeScratchDir } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, describe, expect, it } from 'vitest';

const BUILT_POOL = pathToFileURL(safePath.resolve(import.meta.dirname, '..', '..', 'dist', 'parse-pool.js')).href;

/** Far past the two cold parses the child makes; a child still running at it is a hang, and red. */
const CHILD_TIMEOUT_MS = 30_000;

describe('a process whose last work is a pool shutdown', () => {
  const scratch = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-parked-exit-'));
  afterAll(async () => {
    await removeScratchDir(scratch);
  });

  it('runs on past it, through a second pool that adopts the parked thread, to its end', () => {
    const script = [
      `const { createParsePool } = await import(${JSON.stringify(BUILT_POOL)});`,
      String.raw`for (const content of ["# a\n", "# b\n"]) {`,
      '  const pool = createParsePool({ size: 1 });',
      '  await pool.parse("markdown", content, content.length);',
      '  await pool.shutdown();',
      '  process.stdout.write(`shut down ${content.trim()}\\n`);',
      '}',
    ].join('\n');

    // A file, never `-e` with `--input-type`: a worker inherits the parent's execArgv, and that flag
    // refuses to load any file — the worker's own entry included.
    const scriptPath = safePath.join(scratch, 'two-pools.mjs');
    writeFileSync(scriptPath, script, 'utf-8');
    const result = spawnSync(NODE_EXECUTABLE, [scriptPath], {
      encoding: 'utf-8',
      timeout: CHILD_TIMEOUT_MS,
    });

    expect({ status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }).toStrictEqual({
      status: 0,
      signal: null,
      stdout: 'shut down # a\nshut down # b\n',
      stderr: '',
    });
  });
});
