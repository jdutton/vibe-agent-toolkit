/**
 * `buildAgentSkill` over a source that is not a regular file. Opening a named
 * pipe for reading blocks until a writer appears, so a FIFO under `scripts/`, at
 * `LICENSE.txt` or as the system prompt hung `vat agent build` forever. A pipe
 * (or a link to one) has no bytes to ship: it is refused as the source's,
 * without being opened — and before anything is written to the output.
 *
 * System tier: the fixture is a real FIFO, made by spawning `mkfifo`. POSIX only.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';

import { createSymlinkAsync, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AGENT_SOURCE_UNREADABLE_CODE, buildAgentSkill } from '../../src/builder.js';
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
    ['a link to a named pipe', 'scripts/link', true],
  ] as const)('refuses %s under scripts/ as an unreadable source, without blocking on it', async ([, relative, linked], { skip }) => {
    const cap = linked ? (symlinkCapability() ?? skip()) : undefined;
    const { agentDir, manifestPath } = await writeMinimalAgent(tempDir, linked ? 'fifo-link' : 'fifo-pipe');
    await fs.mkdir(safePath.join(agentDir, 'scripts'));
    // The linked pipe sits beside scripts/, so only the link is under it.
    const fifo = safePath.join(agentDir, linked ? 'pipe' : relative);
    execFileSync('mkfifo', [fifo]);
    if (cap !== undefined) await createSymlinkAsync(cap, '../pipe', safePath.join(agentDir, relative));

    const outcome = await buildRacingThePipe(fifo, { agentPath: manifestPath });
    expect(outcome).toMatchObject({ code: AGENT_SOURCE_UNREADABLE_CODE, message: expect.stringContaining(relative) as unknown });
  });

  it.for([
    ['LICENSE.txt', 'LICENSE.txt', 'fifo-license'],
    ['the system prompt', 'prompts/system.md', 'fifo-prompt'],
  ] as const)('refuses %s as an unreadable source, without blocking on it or writing output', async ([, relative, name]) => {
    const { agentDir, manifestPath } = await writeMinimalAgent(tempDir, name);
    const fifo = safePath.join(agentDir, relative);
    await fs.rm(fifo, { force: true });
    execFileSync('mkfifo', [fifo]);
    const out = safePath.join(tempDir, 'out');

    const outcome = await buildRacingThePipe(fifo, { agentPath: manifestPath, outputPath: out });
    expect(outcome).toMatchObject({ code: AGENT_SOURCE_UNREADABLE_CODE, message: expect.stringContaining(relative) as unknown });
    await expect(fs.access(out)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
