/**
 * `buildAgentSkill` over a `scripts/` holding something that is not a regular
 * file. Opening a named pipe for reading blocks until a writer appears, so a
 * FIFO under `scripts/` hung `vat agent build` forever. A pipe (or a link to
 * one) has no bytes to ship: it is refused as the source's, without being opened.
 *
 * Integration tier: the fixture is a real FIFO, made with `mkfifo`. POSIX only.
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

describe.skipIf(process.platform === 'win32')('buildAgentSkill - a named pipe under scripts/', () => {
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
  ] as const)('refuses %s as an unreadable source, without blocking on it', async ([, relative, linked], { skip }) => {
    const cap = linked ? (symlinkCapability() ?? skip()) : undefined;
    const { agentDir, manifestPath } = await writeMinimalAgent(tempDir, linked ? 'fifo-link' : 'fifo-pipe');
    await fs.mkdir(safePath.join(agentDir, 'scripts'));
    // The linked pipe sits beside scripts/, so only the link is under it.
    const fifo = safePath.join(agentDir, linked ? 'pipe' : relative);
    execFileSync('mkfifo', [fifo]);
    if (cap !== undefined) await createSymlinkAsync(cap, '../pipe', safePath.join(agentDir, relative));

    let timer: NodeJS.Timeout | undefined;
    try {
      const hung = new Promise((resolve) => { timer = setTimeout(() => resolve('hung on the pipe'), HANG_MS); });
      const outcome = await Promise.race([buildAgentSkill({ agentPath: manifestPath }).then(() => 'built', (error: unknown) => error), hung]);
      expect(outcome).toMatchObject({ code: AGENT_SOURCE_UNREADABLE_CODE, message: expect.stringContaining(relative) as unknown });
    } finally {
      clearTimeout(timer);
      // Release a reader a failing build left blocked: opening read-write never blocks, and is a writer.
      await (await fs.open(fifo, 'r+')).close();
    }
  });
});
