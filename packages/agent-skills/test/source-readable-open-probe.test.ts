/**
 * "Is the source readable?" must be answered by OPENING it for reading, never by
 * `access(R_OK)`. Node documents that on Windows `access()` ignores ACLs, so an
 * ACL-denied source passed the check and failed later inside the copy: under the
 * packager's OUTPUT guard (an unfinished run with a write remedy), and in the
 * agent builder unguarded (`INTERNAL_ERROR`).
 *
 * Windows ACLs cannot be set from macOS or Linux, so this models one: `open`
 * refuses a marked path while `access` — left real — says the file is readable,
 * exactly the disagreement a Windows ACL produces.
 */

import type * as FsPromises from 'node:fs/promises';
import fs from 'node:fs/promises';

import { FS_FAULT_CODE, safePath } from '@vibe-agent-toolkit/utils';
import { setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildAgentSkill } from '../src/builder.js';
import { copyIntoBundle } from '../src/bundle-copy.js';
import { isSkillPackagingInputError } from '../src/packaging-errors.js';

const { ACL_DENIED, TURNS_UNREADABLE, opensSeen } = vi.hoisted(() => ({
  ACL_DENIED: 'acl-denied',
  // Opens once (the build's pre-read proves it readable), then is refused: it turned unreadable before the copy.
  TURNS_UNREADABLE: 'turns-unreadable',
  opensSeen: new Map<string, number>(),
}));

/** Whether this open of `path` is refused: always for an ACL-denied file, after its first open for one that turns unreadable. */
function refusesOpen(path: string): boolean {
  if (path.includes(ACL_DENIED)) return true;
  if (!path.includes(TURNS_UNREADABLE)) return false;
  const seen = (opensSeen.get(path) ?? 0) + 1;
  opensSeen.set(path, seen);
  return seen > 1;
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  const open = ((path: Parameters<typeof real.open>[0], ...rest: unknown[]) =>
    refusesOpen(String(path))
      ? Promise.reject(Object.assign(new Error(`EPERM: operation not permitted, open '${String(path)}'`), {
        code: 'EPERM', syscall: 'open', path: String(path),
      }))
      : (real.open as (...args: unknown[]) => ReturnType<typeof real.open>)(path, ...rest)) as typeof real.open;
  return { ...real, open, default: { ...real, open } };
});

/** An agent package under `tempDir` whose `scripts/` holds `scriptName`. */
async function writeAgentWithScript(tempDir: string, name: string, scriptName: string): Promise<string> {
  const agentDir = safePath.join(tempDir, name);
  await fs.mkdir(safePath.join(agentDir, 'prompts'), { recursive: true });
  await fs.mkdir(safePath.join(agentDir, 'scripts'), { recursive: true });
  await fs.writeFile(safePath.join(agentDir, 'package.json'), JSON.stringify({ name }));
  await fs.writeFile(safePath.join(agentDir, 'prompts', 'system.md'), 'Prompt');
  await fs.writeFile(safePath.join(agentDir, 'scripts', scriptName), 'run();');
  const manifestPath = safePath.join(agentDir, 'agent.yaml');
  await fs.writeFile(
    manifestPath,
    `metadata:\n  name: ${name}\n  description: ACL probe\n\nspec:\n  llm:\n    provider: anthropic\n`
      + '    model: claude-sonnet-5\n  prompts:\n    system:\n      $ref: ./prompts/system.md\n',
  );
  return manifestPath;
}

describe('a source the OS lets access() pass but refuses to open', () => {
  const suite = setupAsyncTempDirSuite('acl-probe');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('is refused by copyIntoBundle as the skill\'s unreadable source, not as an unwritable output', async () => {
    const source = safePath.join(tempDir, `${ACL_DENIED}.md`);
    await fs.writeFile(source, '# denied');

    const thrown = await copyIntoBundle('linked file acl-denied.md', source, tempDir, safePath.join(tempDir, 'out', 'x.md'))
      .then(() => undefined, (error: unknown) => error);

    expect(isSkillPackagingInputError(thrown), String(thrown)).toBe(true);
    expect(thrown).toMatchObject({ code: FS_FAULT_CODE, side: 'source', faultClass: 'refused', origin: 'content' });
    expect((thrown as Error).message).toContain('linked file acl-denied.md');
  });

  it('is refused by the agent builder as an unreadable agent source, before anything is copied', async () => {
    const manifestPath = await writeAgentWithScript(tempDir, 'acl-agent', `${ACL_DENIED}.js`);

    await expect(buildAgentSkill({ agentPath: manifestPath })).rejects.toMatchObject({
      code: FS_FAULT_CODE,
      side: 'source',
      faultClass: 'refused',
      message: expect.stringContaining(`${ACL_DENIED}.js`) as unknown,
    });
  });

  // The pre-read proved it readable; the copy is the read that fails. That copy writes the output
  // too, but the path the OS named is the agent's own file, so the fault is the source's, by path.
  it('is refused by the agent builder as the source when it turns unreadable between the pre-read and the copy', async () => {
    const manifestPath = await writeAgentWithScript(tempDir, 'flaky-agent', `${TURNS_UNREADABLE}.js`);

    await expect(buildAgentSkill({ agentPath: manifestPath })).rejects.toMatchObject({
      code: FS_FAULT_CODE,
      side: 'source',
      faultClass: 'refused',
      message: expect.stringContaining(`${TURNS_UNREADABLE}.js`) as unknown,
    });
    expect(opensSeen.get([...opensSeen.keys()].find((path) => path.includes(TURNS_UNREADABLE)) ?? '')).toBe(2);
  });
});
