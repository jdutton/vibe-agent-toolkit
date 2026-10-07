/**
 * `buildAgentSkill` and the output it writes into.
 *
 * VAT never deletes or overwrites what it did not produce: an explicit
 * `outputPath` whose `<output>/<agent>/` already holds anything is refused, and
 * left exactly as it was, unless `replaceExistingOutput` (`--force`) says it is
 * a previous build — the same rule, and the same check, as `vat skills package
 * -o`. And every source is proven readable before the output is touched, so a
 * refused source never leaves a half-written bundle (or a previous build's
 * SKILL.md overwritten beside its stale scripts/).
 */
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AGENT_SOURCE_UNREADABLE_CODE, buildAgentSkill } from '../../src/builder.js';
import { SKILL_PACKAGING_OUTPUT_OCCUPIED_CODE } from '../../src/packaging-errors.js';
import { writeMinimalAgent } from '../test-helpers.js';

const USER_SKILL = 'USER SKILL.md precious';
const USER_SCRIPT = 'user script';

/** An agent named `name`, and a user's own files at `<out>/<name>/`. */
async function agentOverUserFiles(tempDir: string, name: string): Promise<{ manifestPath: string; out: string; userDir: string }> {
  const { agentDir, manifestPath } = await writeMinimalAgent(tempDir, name);
  await fs.mkdir(safePath.join(agentDir, 'scripts'));
  await fs.writeFile(safePath.join(agentDir, 'scripts', 'run.js'), 'agent script');
  const out = safePath.join(tempDir, 'userout');
  const userDir = safePath.join(out, name);
  await fs.mkdir(safePath.join(userDir, 'scripts'), { recursive: true });
  await fs.writeFile(safePath.join(userDir, 'SKILL.md'), USER_SKILL);
  await fs.writeFile(safePath.join(userDir, 'scripts', 'run.js'), USER_SCRIPT);
  return { manifestPath, out, userDir };
}

describe('buildAgentSkill - output ownership', () => {
  const suite = setupAsyncTempDirSuite('agent-build-output');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('refuses an explicit output already holding files it did not make, naming the path, and leaves them', async () => {
    const { manifestPath, out, userDir } = await agentOverUserFiles(tempDir, 'occupied');

    await expect(buildAgentSkill({ agentPath: manifestPath, outputPath: out })).rejects.toMatchObject({
      code: SKILL_PACKAGING_OUTPUT_OCCUPIED_CODE,
      message: expect.stringContaining('userout/occupied') as unknown,
    });
    expect(await fs.readFile(safePath.join(userDir, 'SKILL.md'), 'utf-8')).toBe(USER_SKILL);
    expect(await fs.readFile(safePath.join(userDir, 'scripts', 'run.js'), 'utf-8')).toBe(USER_SCRIPT);
  });

  it('replaces the output with replaceExistingOutput (--force), leaving nothing of the old one', async () => {
    const { manifestPath, out, userDir } = await agentOverUserFiles(tempDir, 'forced');
    await fs.writeFile(safePath.join(userDir, 'stale.txt'), 'left from before');

    await buildAgentSkill({ agentPath: manifestPath, outputPath: out, replaceExistingOutput: true });

    expect(await fs.readFile(safePath.join(userDir, 'SKILL.md'), 'utf-8')).toContain('name: forced');
    expect(await fs.readFile(safePath.join(userDir, 'scripts', 'run.js'), 'utf-8')).toBe('agent script');
    expect(existsSync(safePath.join(userDir, 'stale.txt'))).toBe(false);
  });

  it('builds into an empty output directory as-is', async () => {
    const { manifestPath } = await writeMinimalAgent(tempDir, 'empty-out');
    const out = safePath.join(tempDir, 'emptyout');
    await fs.mkdir(safePath.join(out, 'empty-out'), { recursive: true });

    const result = await buildAgentSkill({ agentPath: manifestPath, outputPath: out });
    expect(existsSync(safePath.join(result.outputPath, 'SKILL.md'))).toBe(true);
  });

  it('refuses an output that is the agent\'s own source, even with replaceExistingOutput', async () => {
    // `<tempDir>/<name>` IS the agent directory: removing it would delete the source.
    const { agentDir, manifestPath } = await writeMinimalAgent(tempDir, 'self-output');

    await expect(buildAgentSkill({ agentPath: manifestPath, outputPath: tempDir, replaceExistingOutput: true }))
      .rejects.toMatchObject({ code: SKILL_PACKAGING_OUTPUT_OCCUPIED_CODE });
    expect(existsSync(manifestPath)).toBe(true);
    expect(existsSync(safePath.join(agentDir, 'prompts', 'system.md'))).toBe(true);
  });

  it('rebuilds its own default output without --force', async () => {
    const { manifestPath } = await writeMinimalAgent(tempDir, 'rebuild-default');
    const first = await buildAgentSkill({ agentPath: manifestPath });
    const second = await buildAgentSkill({ agentPath: manifestPath });
    expect(second.outputPath).toBe(first.outputPath);
  });

  it('refuses an unreadable scripts/ before writing anything to the output', async () => {
    const { agentDir, manifestPath } = await writeMinimalAgent(tempDir, 'scripts-refused');
    await fs.writeFile(safePath.join(agentDir, 'scripts'), 'not a directory');
    const out = safePath.join(tempDir, 'untouched');

    await expect(buildAgentSkill({ agentPath: manifestPath, outputPath: out }))
      .rejects.toMatchObject({ code: AGENT_SOURCE_UNREADABLE_CODE });
    expect(existsSync(out)).toBe(false);
  });

  it('refuses an unreadable LICENSE.txt before a previous build\'s SKILL.md is overwritten', async () => {
    const { agentDir, manifestPath } = await writeMinimalAgent(tempDir, 'license-refused');
    const out = safePath.join(tempDir, 'previous');
    await buildAgentSkill({ agentPath: manifestPath, outputPath: out });
    const skillMd = safePath.join(out, 'license-refused', 'SKILL.md');
    const before = await fs.readFile(skillMd, 'utf-8');
    await fs.writeFile(safePath.join(agentDir, 'prompts', 'system.md'), 'A CHANGED prompt');
    await fs.mkdir(safePath.join(agentDir, 'LICENSE.txt'));

    await expect(buildAgentSkill({ agentPath: manifestPath, outputPath: out, replaceExistingOutput: true }))
      .rejects.toMatchObject({ code: AGENT_SOURCE_UNREADABLE_CODE });
    expect(await fs.readFile(skillMd, 'utf-8')).toBe(before);
  });
});
