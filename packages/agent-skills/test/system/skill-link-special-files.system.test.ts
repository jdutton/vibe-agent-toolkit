/**
 * A skill linking to a named pipe. Opening a pipe for reading blocks until a
 * writer appears, so a FIFO `.md` linked from SKILL.md hung `vat skills package`
 * (in `validateSkill`) and `vat skills build` (in `validateSkillForPackaging`)
 * forever; a non-markdown one was dropped from the package silently, leaving its
 * link dangling. Both lanes now refuse it, unread, as `LINK_TARGET_UNREADABLE`.
 *
 * System tier: the fixture is a real FIFO, made by spawning `mkfifo`. POSIX only.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { gitExecutable, resolveExecutable, setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { validateSkillForPackaging } from '../../src/validators/packaging-validator.js';
import { validateSkill } from '../../src/validators/skill-validator.js';

/** How long a validation may take before the test calls it hung on the pipe. */
const HANG_MS = 5000;

describe.skipIf(process.platform === 'win32')('skill validation - a link to a named pipe', () => {
  const suite = setupAsyncTempDirSuite('skill-link-fifo');
  let skillPath = '';
  let fifo = '';

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(async () => {
    await suite.beforeEach();
    const root = suite.getTempDir();
    // A real repository and config root, so the packaging lane's crawl finds the skill and stays inside the fixture.
    execFileSync(gitExecutable(), ['init', '-q', root]);
    await fs.writeFile(safePath.join(root, 'vibe-agent-toolkit.config.yaml'), 'skills:\n  include: ["sk/SKILL.md"]\n');
    mkdirSyncReal(safePath.join(root, 'sk', 'ref'), { recursive: true });
    skillPath = safePath.join(root, 'sk', 'SKILL.md');
  });
  afterEach(async () => {
    // Release a reader a failing lane left blocked: opening read-write never blocks, and is a writer.
    await (await fs.open(fifo, 'r+')).close();
  });

  /** Plant the skill linking `href`, with a FIFO at it. */
  async function plantSkillLinkingPipe(href: string): Promise<void> {
    await fs.writeFile(
      skillPath,
      `---\nname: sk\ndescription: A skill whose linked file is a named pipe, for this test only.\n---\n# Sk\n\nSee [it](${href}).\n`,
    );
    fifo = safePath.join(safePath.resolve(skillPath, '..'), href);
    execFileSync(resolveExecutable('mkfifo'), [fifo]);
  }

  /** Run `validate`, or report that it hung. */
  async function withinBound<T>(validate: () => Promise<T>): Promise<T | 'hung on the pipe'> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const hung = new Promise<'hung on the pipe'>((resolve) => { timer = setTimeout(() => resolve('hung on the pipe'), HANG_MS); });
      return await Promise.race([validate(), hung]);
    } finally {
      clearTimeout(timer);
    }
  }

  it.for(['ref/notes.md', 'data.txt'])('validateSkill refuses a pipe at %s as LINK_TARGET_UNREADABLE', async (href) => {
    await plantSkillLinkingPipe(href);
    const result = await withinBound(() => validateSkill({ skillPath, validation: {} }));
    expect(result).not.toBe('hung on the pipe');
    expect(result === 'hung on the pipe' ? [] : result.issues).toContainEqual(expect.objectContaining({
      code: 'LINK_TARGET_UNREADABLE',
      severity: 'error',
      link: href,
      message: expect.stringContaining('not a regular file') as unknown,
    }));
  });

  it('validateSkillForPackaging refuses a pipe .md as LINK_TARGET_UNREADABLE', async () => {
    await plantSkillLinkingPipe('ref/notes.md');
    const result = await withinBound(() => validateSkillForPackaging(skillPath));
    expect(result).not.toBe('hung on the pipe');
    expect(result === 'hung on the pipe' ? [] : result.allErrors).toContainEqual(expect.objectContaining({
      code: 'LINK_TARGET_UNREADABLE',
      message: expect.stringContaining('not a regular file') as unknown,
    }));
  });
});
