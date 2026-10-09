/**
 * `buildAgentSkill` and the output it writes into.
 *
 * VAT never deletes or overwrites what it did not produce: an explicit
 * `outputPath` whose `<output>/<agent>/` already holds anything is refused, and
 * left exactly as it was, unless `replaceExistingOutput` (`--force`) says it is
 * a previous build — the same rule as `vat skills package -o` (`packageOwnership`).
 * The build is ONE tree-change plan: it lands whole, or changes nothing — a previous
 * build is never removed first, and a failure partway leaves it byte-equal.
 */
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';

import { FS_FAULT_CODE, safePath, TREE_DEST_HOLDS_SOURCE_CODE, TREE_DEST_NOT_OWNED_CODE } from '@vibe-agent-toolkit/utils';
import { diffSnapshots, installFaultFs, setupAsyncTempDirSuite, snapshotTree } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildAgentSkill } from '../../src/builder.js';
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

  // The direct test of a refusal no fault-matrix case can be (its GOLDEN must be clean): a
  // user-named --output holding what VAT did not make, no --force — refused, the tree byte-unchanged.
  it('refuses an explicit output already holding files it did not make, naming the path and --force, and the tree is byte-unchanged', async () => {
    const { manifestPath, out, userDir } = await agentOverUserFiles(tempDir, 'occupied');
    const before = snapshotTree(tempDir);

    await expect(buildAgentSkill({ agentPath: manifestPath, outputPath: out, formats: ['directory', 'zip', 'marketplace'] })).rejects.toMatchObject({
      code: TREE_DEST_NOT_OWNED_CODE,
      message: expect.stringMatching(/userout\/occupied.*--force/s) as unknown,
    });
    expect(diffSnapshots(before, snapshotTree(tempDir))).toEqual([]);
    expect(await fs.readFile(safePath.join(userDir, 'SKILL.md'), 'utf-8')).toBe(USER_SKILL);
  });

  it('leaves a previous build byte-equal, and nothing beside it, when a --force rebuild fails partway', async () => {
    const { agentDir, manifestPath } = await writeMinimalAgent(tempDir, 'partway');
    await fs.writeFile(safePath.join(agentDir, 'LICENSE.txt'), 'MIT');
    const out = safePath.join(tempDir, 'out');
    await buildAgentSkill({ agentPath: manifestPath, outputPath: out });
    await fs.writeFile(safePath.join(agentDir, 'prompts', 'system.md'), 'A CHANGED prompt');
    const before = snapshotTree(tempDir);

    // The new build's LICENSE.txt write is refused, after its SKILL.md is written.
    const session = installFaultFs({
      within: tempDir,
      faults: [{ family: 'write', path: (path) => path.includes('/.partway.vat-staged-') && path.endsWith('/LICENSE.txt'), errno: 'ENOSPC' }],
    });
    try {
      await expect(buildAgentSkill({ agentPath: manifestPath, outputPath: out, replaceExistingOutput: true }))
        .rejects.toMatchObject({ code: FS_FAULT_CODE, side: 'destination' });
    } finally {
      session.restore();
    }
    expect(diffSnapshots(before, snapshotTree(tempDir))).toEqual([]);
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
      .rejects.toMatchObject({ code: TREE_DEST_HOLDS_SOURCE_CODE });
    expect(existsSync(manifestPath)).toBe(true);
    expect(existsSync(safePath.join(agentDir, 'prompts', 'system.md'))).toBe(true);
  });

  it('replaces its own default output without --force: VAT\'s location, nothing of the previous build kept', async () => {
    const { manifestPath } = await writeMinimalAgent(tempDir, 'rebuild-default');
    const first = await buildAgentSkill({ agentPath: manifestPath });
    await fs.writeFile(safePath.join(first.outputPath, 'stale.txt'), 'left from before');
    const second = await buildAgentSkill({ agentPath: manifestPath });
    expect(second.outputPath).toBe(first.outputPath);
    expect(existsSync(safePath.join(second.outputPath, 'stale.txt'))).toBe(false);
    expect(second.residue).toEqual([]);
  });

  it('refuses an unreadable scripts/ before writing anything to the output', async () => {
    const { agentDir, manifestPath } = await writeMinimalAgent(tempDir, 'scripts-refused');
    await fs.writeFile(safePath.join(agentDir, 'scripts'), 'not a directory');
    const out = safePath.join(tempDir, 'untouched');

    await expect(buildAgentSkill({ agentPath: manifestPath, outputPath: out }))
      .rejects.toMatchObject({ code: FS_FAULT_CODE, side: 'source' });
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
      .rejects.toMatchObject({ code: FS_FAULT_CODE, side: 'source' });
    expect(await fs.readFile(skillMd, 'utf-8')).toBe(before);
  });
});
