/**
 * `buildAgentSkill` over a source that is not a regular file. Opening a named
 * pipe for reading blocks until a writer appears, so a FIFO under `scripts/`, at
 * `LICENSE.txt` or as the system prompt hung `vat agent build` forever. A pipe
 * has no bytes to ship: it is refused as the source's (an `FS_FAULT` of class
 * `wrong-type`), without being opened — and before anything is written to the
 * output. A link under `scripts/` to a pipe outside it is refused as the escape
 * it is, before its target is examined.
 *
 * System tier: the fixture is a real FIFO, made by spawning `mkfifo`. POSIX only.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';

import { COPY_LINK_ESCAPES_SOURCE_CODE, createSymlinkAsync, FS_FAULT_CODE, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { resolveExecutable, setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildAgentSkill } from '../../src/builder.js';
import { writeMinimalAgent } from '../test-helpers.js';

/** How long a build may take before the test calls it hung on the pipe. */
const HANG_MS = 3000;

/**
 * Build the agent, or report that it hung on `fifo`. The pipe is released
 * afterwards either way: opening read-write never blocks, and is a writer, so a
 * reader a failing build left blocked is freed.
 */
async function buildRacingThePipe(fifo: string, options: Parameters<typeof buildAgentSkill>[0]): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const hung = new Promise((resolve) => { timer = setTimeout(() => resolve('hung on the pipe'), HANG_MS); });
    return await Promise.race([buildAgentSkill(options).then(() => 'built', (error: unknown) => error), hung]);
  } finally {
    clearTimeout(timer);
    await (await fs.open(fifo, 'r+')).close();
  }
}

describe.skipIf(process.platform === 'win32')('buildAgentSkill - a named pipe as a source', () => {
  const suite = setupAsyncTempDirSuite('agent-build-fifo');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it.for([
    ['a named pipe', 'scripts/pipe', false],
    ['a link to a named pipe outside scripts/', 'scripts/link', true],
  ] as const)('refuses %s as the source\'s, without blocking on it', async ([, relative, linked], { skip }) => {
    const cap = linked ? (symlinkCapability() ?? skip()) : undefined;
    const { agentDir, manifestPath } = await writeMinimalAgent(tempDir, linked ? 'fifo-link' : 'fifo-pipe');
    await fs.mkdir(safePath.join(agentDir, 'scripts'));
    // The linked pipe sits beside scripts/, so only the link is under it.
    const fifo = safePath.join(agentDir, linked ? 'pipe' : relative);
    execFileSync(resolveExecutable('mkfifo'), [fifo]);
    if (cap !== undefined) await createSymlinkAsync(cap, '../pipe', safePath.join(agentDir, relative));

    const outcome = await buildRacingThePipe(fifo, { agentPath: manifestPath });
    // A link out of scripts/ is refused as the escape it is, before its target is examined.
    const refusal = linked ? { code: COPY_LINK_ESCAPES_SOURCE_CODE } : { code: FS_FAULT_CODE, side: 'source', faultClass: 'wrong-type' };
    expect(outcome).toMatchObject({ ...refusal, message: expect.stringContaining(relative) as unknown });
  });

  // A link INSIDE scripts/ to a pipe also inside it: the walk follows the link, so whichever of the two
  // the listing reaches first is refused as a special file — and the build never blocks on either.
  it('refuses a link inside scripts/ to a named pipe inside it, without blocking on it', async ({ skip }) => {
    const cap = symlinkCapability() ?? skip();
    const { agentDir, manifestPath } = await writeMinimalAgent(tempDir, 'fifo-contained-link');
    await fs.mkdir(safePath.join(agentDir, 'scripts'));
    const fifo = safePath.join(agentDir, 'scripts', 'pipe');
    execFileSync(resolveExecutable('mkfifo'), [fifo]);
    const link = safePath.join(agentDir, 'scripts', 'link');
    await createSymlinkAsync(cap, 'pipe', link);

    const outcome = await buildRacingThePipe(fifo, { agentPath: manifestPath });
    expect(outcome).toMatchObject({ code: FS_FAULT_CODE, side: 'source', faultClass: 'wrong-type', errno: 'EFTYPE' });
    expect([fifo, link]).toContain((outcome as { path?: string }).path);
  });

  // A previous build holding a named pipe where SKILL.md goes: the build used to write its default
  // location IN PLACE, and opening that pipe for writing blocked forever. Built whole beside it and
  // swapped in, the build never opens anything in the previous tree — the pipe goes with it.
  it('replaces a previous build holding a named pipe at SKILL.md, never writing into it', async () => {
    const { manifestPath } = await writeMinimalAgent(tempDir, 'fifo-previous');
    const first = await buildAgentSkill({ agentPath: manifestPath });
    const previousSkill = safePath.join(first.outputPath, 'SKILL.md');
    await fs.rm(previousSkill);
    execFileSync(resolveExecutable('mkfifo'), [previousSkill]);

    let timer: NodeJS.Timeout | undefined;
    const hung = new Promise((resolve) => { timer = setTimeout(() => resolve('hung on the pipe'), HANG_MS); });
    let outcome: unknown;
    try {
      outcome = await Promise.race([buildAgentSkill({ agentPath: manifestPath }).then(() => 'built', (error: unknown) => error), hung]);
    } finally {
      clearTimeout(timer);
      // A build blocked on the pipe is released by a writer; a build that replaced it left none.
      const left = await fs.lstat(previousSkill).catch(() => undefined);
      if (left?.isFIFO() === true) await (await fs.open(previousSkill, 'r+')).close();
    }

    expect(outcome).toBe('built');
    expect((await fs.lstat(previousSkill)).isFile()).toBe(true);
  });

  it.for([
    ['LICENSE.txt', 'LICENSE.txt', 'fifo-license'],
    ['the system prompt', 'prompts/system.md', 'fifo-prompt'],
  ] as const)('refuses %s as an unreadable source, without blocking on it or writing output', async ([, relative, name]) => {
    const { agentDir, manifestPath } = await writeMinimalAgent(tempDir, name);
    const fifo = safePath.join(agentDir, relative);
    await fs.rm(fifo, { force: true });
    execFileSync(resolveExecutable('mkfifo'), [fifo]);
    const out = safePath.join(tempDir, 'out');

    const outcome = await buildRacingThePipe(fifo, { agentPath: manifestPath, outputPath: out });
    expect(outcome).toMatchObject({ code: FS_FAULT_CODE, side: 'source', faultClass: 'wrong-type', message: expect.stringContaining(relative) as unknown });
    await expect(fs.access(out)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
