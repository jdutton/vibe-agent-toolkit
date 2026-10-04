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

import { safePath } from '@vibe-agent-toolkit/utils';
import { setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AGENT_SOURCE_UNREADABLE_CODE, buildAgentSkill } from '../src/builder.js';
import { copyIntoBundle } from '../src/fs-attribution.js';
import { isSkillPackagingInputError } from '../src/packaging-errors.js';

const { ACL_DENIED } = vi.hoisted(() => ({ ACL_DENIED: 'acl-denied' }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  const open = ((path: Parameters<typeof real.open>[0], ...rest: unknown[]) =>
    String(path).includes(ACL_DENIED)
      ? Promise.reject(Object.assign(new Error(`EPERM: operation not permitted, open '${String(path)}'`), {
        code: 'EPERM', syscall: 'open', path: String(path),
      }))
      : (real.open as (...args: unknown[]) => ReturnType<typeof real.open>)(path, ...rest)) as typeof real.open;
  return { ...real, open, default: { ...real, open } };
});

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

    const thrown = await copyIntoBundle('linked file acl-denied.md', source, safePath.join(tempDir, 'out', 'x.md'))
      .then(() => undefined, (error: unknown) => error);

    expect(isSkillPackagingInputError(thrown), String(thrown)).toBe(true);
  });

  it('is refused by the agent builder as an unreadable agent source, before anything is copied', async () => {
    const agentDir = safePath.join(tempDir, 'agent');
    await fs.mkdir(safePath.join(agentDir, 'prompts'), { recursive: true });
    await fs.mkdir(safePath.join(agentDir, 'scripts'), { recursive: true });
    await fs.writeFile(safePath.join(agentDir, 'package.json'), JSON.stringify({ name: 'acl-agent' }));
    await fs.writeFile(safePath.join(agentDir, 'prompts', 'system.md'), 'Prompt');
    await fs.writeFile(safePath.join(agentDir, 'scripts', `${ACL_DENIED}.js`), 'run();');
    const manifestPath = safePath.join(agentDir, 'agent.yaml');
    await fs.writeFile(
      manifestPath,
      'metadata:\n  name: acl-agent\n  description: ACL probe\n\nspec:\n  llm:\n    provider: anthropic\n'
        + '    model: claude-sonnet-5\n  prompts:\n    system:\n      $ref: ./prompts/system.md\n',
    );

    await expect(buildAgentSkill({ agentPath: manifestPath })).rejects.toMatchObject({
      code: AGENT_SOURCE_UNREADABLE_CODE,
      message: expect.stringContaining(`${ACL_DENIED}.js`) as unknown,
    });
  });
});
