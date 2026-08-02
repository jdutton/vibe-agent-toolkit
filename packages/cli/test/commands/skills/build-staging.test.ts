/* eslint-disable security/detect-non-literal-fs-filename -- test code writes into its own temp dirs */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';

import type { SkillPackagingConfig } from '@vibe-agent-toolkit/agent-skills';
import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  runSkillBuild,
  type BuildSkillSpec,
  type SkillBuildRun,
  type SkillBuildRunInput,
} from '../../../src/commands/skills/build.js';
import { createTempDirTracker } from '../../system/test-common.js';
import { silentLogger as SILENT_LOGGER } from '../../test-doubles.js';

/**
 * A body whose relative link resolves to nothing: `LINK_MISSING_TARGET`, an
 * `error` in the SOURCE lane, so this skill fails the PRE-build gate — the one
 * that used to `process.exit` inside the per-skill loop.
 */
const BROKEN_BODY = 'See [the missing companion](./nope.md).';
const CLEAN_BODY = 'Nothing to see.';

/**
 * Byte content of a bundle from a PREVIOUS, good build. Asserted verbatim: a
 * build that half-wrote its replacement before failing would leave a directory
 * that still exists, so existence alone cannot tell "untouched" from "clobbered".
 */
const PREVIOUS_BUNDLE = 'previous good output — a failed build must not touch this\n';

async function writeSkill(cwd: string, name: string, body: string): Promise<BuildSkillSpec> {
  const dir = safePath.join(cwd, 'skills', name);
  await mkdir(dir, { recursive: true });
  const sourcePath = safePath.join(dir, 'SKILL.md');
  await writeFile(
    sourcePath,
    `---\nname: ${name}\ndescription: A skill used to exercise vat skills build in tests.\n---\n\n# ${name}\n\n${body}\n`,
  );
  return { skill: { name, sourcePath }, packagingConfig: {} as SkillPackagingConfig };
}

/** Build the named skills (name → body) in one run, optionally in `--skill` mode. */
async function build(
  cwd: string,
  skills: ReadonlyArray<readonly [name: string, body: string]>,
  onlySkill?: string,
): Promise<SkillBuildRun> {
  const specs: BuildSkillSpec[] = [];
  for (const [name, body] of skills) specs.push(await writeSkill(cwd, name, body));
  // `[]`: these fixtures declare no eval suites, so the project-wide test-input
  // list is genuinely empty — not a lane declining to supply it.
  const input: SkillBuildRunInput = {
    specs,
    cwd,
    logger: SILENT_LOGGER,
    projectSkills: [],
    onlySkill,
    verbose: false,
  };
  return runSkillBuild(input);
}

/** Seed `dist/skills/<name>/SKILL.md` for each name, as a previous build would have. */
async function seedPreviousOutput(cwd: string, names: readonly string[]): Promise<void> {
  for (const name of names) {
    const dir = safePath.join(cwd, 'dist', 'skills', name);
    await mkdir(dir, { recursive: true });
    await writeFile(safePath.join(dir, 'SKILL.md'), PREVIOUS_BUNDLE);
  }
}

const readBundle = (cwd: string, name: string): Promise<string> =>
  readFile(safePath.join(cwd, 'dist', 'skills', name, 'SKILL.md'), 'utf8');

/** Everything under `dist/`, sorted — the check for a leftover staging tree. */
const distEntries = (cwd: string): Promise<string[]> =>
  readdir(safePath.join(cwd, 'dist')).then((e) => e.toSorted((a, b) => a.localeCompare(b)));

describe('runSkillBuild - one run reports EVERY pre-build validation failure', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-build-staging-validate-');

  beforeEach(() => {
    // A guard, not a convenience: collecting failures instead of aborting is the
    // whole point, so any `process.exit` from inside the run is a regression.
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`runSkillBuild called process.exit(${String(code)}) instead of collecting the failure`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    return cleanupTempDirs();
  });

  it('names both failing skills, not just the first', async () => {
    const run = await build(createTempDir(), [
      ['bad-one', BROKEN_BODY],
      ['bad-two', BROKEN_BODY],
      ['good', CLEAN_BODY],
    ]);
    expect(run.validationFailures.map((f) => f.name)).toEqual(['bad-one', 'bad-two']);
  });

  it('publishes each failure\'s own severity counts rather than a flat one-error stand-in', async () => {
    const run = await build(createTempDir(), [['bad-one', BROKEN_BODY], ['good', CLEAN_BODY]]);
    expect(run.validationFailures[0]?.issueCounts.errors).toBeGreaterThanOrEqual(1);
  });

  it('still packages the skills that passed', async () => {
    const run = await build(createTempDir(), [['bad-one', BROKEN_BODY], ['good', CLEAN_BODY]]);
    expect(run.results.map((r) => r.name)).toEqual(['good']);
  });
});

describe('runSkillBuild - dist/skills is replaced only by a build that succeeded', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-build-staging-swap-');

  afterEach(() => cleanupTempDirs());

  it('leaves the previous bundle byte-intact when the run fails', async () => {
    const cwd = createTempDir();
    await seedPreviousOutput(cwd, ['kept']);
    const run = await build(cwd, [['good', CLEAN_BODY], ['bad', BROKEN_BODY]]);

    expect(run.outputCommitted).toBe(false);
    await expect(readBundle(cwd, 'kept')).resolves.toBe(PREVIOUS_BUNDLE);
    // And the run it just discarded left nothing of itself behind.
    await expect(distEntries(cwd)).resolves.toEqual(['skills']);
    await expect(readdir(safePath.join(cwd, 'dist', 'skills'))).resolves.toEqual(['kept']);
  });

  it('promotes the staged tree on success, leaving no staging directory behind', async () => {
    const cwd = createTempDir();
    const run = await build(cwd, [['good', CLEAN_BODY]]);

    expect(run.outputCommitted).toBe(true);
    await expect(readBundle(cwd, 'good')).resolves.toContain('name: good');
    await expect(distEntries(cwd)).resolves.toEqual(['skills']);
  });

  it('reports the FINAL output path, never the path it staged through', async () => {
    const cwd = createTempDir();
    const run = await build(cwd, [['good', CLEAN_BODY]]);
    expect(run.results[0]?.result.outputPath).toBe(safePath.resolve(cwd, 'dist', 'skills', 'good'));
  });

  it('removes a stale bundle the successful build no longer produces', async () => {
    const cwd = createTempDir();
    await seedPreviousOutput(cwd, ['stale']);
    const run = await build(cwd, [['good', CLEAN_BODY]]);

    expect(run.outputCommitted).toBe(true);
    await expect(readdir(safePath.join(cwd, 'dist', 'skills'))).resolves.toEqual(['good']);
  });

  it('replaces only the named skill in --skill mode', async () => {
    const cwd = createTempDir();
    await seedPreviousOutput(cwd, ['one', 'two']);
    const run = await build(cwd, [['one', CLEAN_BODY]], 'one');

    expect(run.outputCommitted).toBe(true);
    await expect(readBundle(cwd, 'one')).resolves.toContain('name: one');
    await expect(readBundle(cwd, 'two')).resolves.toBe(PREVIOUS_BUNDLE);
    await expect(distEntries(cwd)).resolves.toEqual(['skills']);
  });

  it('leaves the named skill\'s previous bundle intact when --skill mode fails', async () => {
    const cwd = createTempDir();
    await seedPreviousOutput(cwd, ['one', 'two']);
    const run = await build(cwd, [['one', BROKEN_BODY]], 'one');

    expect(run.outputCommitted).toBe(false);
    await expect(readBundle(cwd, 'one')).resolves.toBe(PREVIOUS_BUNDLE);
    await expect(readBundle(cwd, 'two')).resolves.toBe(PREVIOUS_BUNDLE);
    await expect(distEntries(cwd)).resolves.toEqual(['skills']);
  });
});
