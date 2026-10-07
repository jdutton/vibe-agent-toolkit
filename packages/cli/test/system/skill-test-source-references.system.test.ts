/**
 * `vat skill test run` with a skill source or eval suite reference that names
 * nothing: an npm package that is not installed, or a scoped specifier passed as
 * a path.
 *
 * Each one is the mistake of whoever wrote the reference, so it is refused by
 * WHERE it was written: on the command line (a `--with` value, `--evals`, the
 * positional) → `USAGE_INVALID`; in the config (`skills.config.<skill>.test`) →
 * `CONFIG_INVALID`. An optional companion that names nothing is skipped with a
 * warning, as any other optional companion that cannot stage is. None of them is
 * `INTERNAL_ERROR`, which is what each one used to be.
 *
 * Every case stops before preflight, so none needs a `claude` binary or auth.
 */

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createSkillMarkdown, createSuiteContext, executeCliAndParseYaml, writeTestFile } from './test-common.js';

/** A scoped package no test machine has installed. */
const ABSENT_PACKAGE = '@vat-absent-fixture/nothing-here';
const SKILL_NAME = 'probe-skill';
const ACK = '--i-understand-this-runs-skill-code';

const ctx = createSuiteContext('vat-skill-test-refs-', import.meta.url);

/**
 * A project declaring one skill (no `evals/`, so a run that gets past source
 * resolution stops at bootstrap), with `testLines` under its
 * `skills.config.<skill>.test` block.
 */
function declaredProject(testLines: readonly string[]): { root: string; skillDir: string } {
  const root = ctx.createTempDir();
  const skillDir = safePath.join(root, 'skills', SKILL_NAME);
  mkdirSyncReal(skillDir, { recursive: true });
  writeTestFile(safePath.join(skillDir, 'SKILL.md'), createSkillMarkdown(SKILL_NAME));
  writeTestFile(safePath.join(root, 'package.json'), JSON.stringify({ name: 'probe-project', private: true }));
  const config = [
    'skills:',
    '  include:',
    '    - "skills/**/SKILL.md"',
    ...(testLines.length === 0 ? [] : ['  config:', `    ${SKILL_NAME}:`, '      test:', ...testLines.map((l) => `        ${l}`)]),
    '',
  ];
  writeTestFile(safePath.join(root, 'vibe-agent-toolkit.config.yaml'), config.join('\n'));
  return { root, skillDir };
}

/** Run `vat skill test run` in `cwd` and return the exit status and the published error. */
async function runSkillTest(cwd: string, args: readonly string[]): Promise<{
  status: number | null;
  error: { code?: string; message?: string } | undefined;
  stderr: string;
}> {
  const outDir = safePath.join(cwd, 'harness-out');
  mkdirSyncReal(outDir, { recursive: true, mode: 0o700 });
  const { result, parsed } = await executeCliAndParseYaml(
    ctx.binPath,
    ['skill', 'test', 'run', ...args, '--dry-run', ACK, '--out', outDir],
    { cwd },
  );
  return { status: result.status, error: parsed['error'] as { code?: string; message?: string } | undefined, stderr: result.stderr };
}

/** The run refused with `code`, exit 2, and its message names the absent package. */
function expectRefusedNaming(run: Awaited<ReturnType<typeof runSkillTest>>, code: string): void {
  expect(run.error?.code, run.stderr).toBe(code);
  expect(run.status).toBe(2);
  expect(run.error?.message).toContain(ABSENT_PACKAGE);
}

describe('vat skill test run: a reference that resolves to nothing (system)', () => {
  beforeAll(ctx.setup);
  afterEach(ctx.cleanup);

  it.each([
    ['a --with npm source with a subpath', (skill: string) => [skill, '--with', `dep=npm:${ABSENT_PACKAGE}@1.0.0/skill`]],
    ['a --with npm source naming the package itself', (skill: string) => [skill, '--with', `dep=npm:${ABSENT_PACKAGE}@1.0.0`]],
    ['a --with npm source with no version pin', (skill: string) => [skill, '--with', `dep=npm:${ABSENT_PACKAGE}`]],
    ['a --with path that is a scoped specifier', (skill: string) => [skill, '--with', `dep=path:${ABSENT_PACKAGE}/skill`]],
    ['--evals', (skill: string) => [skill, '--evals', `${ABSENT_PACKAGE}/evals.json`]],
    ['a skill argument naming an npm source', () => [`npm:${ABSENT_PACKAGE}@1.0.0/skill`]],
    ['a skill argument naming a scoped specifier as a path', () => [`path:${ABSENT_PACKAGE}/skill`]],
  ])('refuses %s as USAGE_INVALID, exit 2, naming it', async (_label, argsFor) => {
    const { root, skillDir } = declaredProject([]);
    expectRefusedNaming(await runSkillTest(root, argsFor(skillDir)), 'USAGE_INVALID');
  });

  it.each([
    ['test.with naming an npm source', ['with:', `  - npm: "${ABSENT_PACKAGE}@1.0.0/skill"`]],
    ['test.with naming an unpinned npm source', ['with:', `  - npm: "${ABSENT_PACKAGE}"`]],
    ['test.with naming a scoped specifier as a path', ['with:', `  - path: "${ABSENT_PACKAGE}/skill"`]],
    ['test.evals', [`evals: "${ABSENT_PACKAGE}/evals.json"`]],
  ])('refuses %s in the config as CONFIG_INVALID, exit 2', async (_label, testLines) => {
    const { root } = declaredProject(testLines);
    expectRefusedNaming(await runSkillTest(root, [SKILL_NAME]), 'CONFIG_INVALID');
  });

  // An optional companion degrades to skip-with-warning on any failure to stage.
  // The run then reaches bootstrap (the fixture ships no evals/), which proves it
  // got past companion staging rather than refusing there.
  it.each([
    ['--with-optional', (root: string) => ({ root, extra: ['--with-optional', `dep=path:${ABSENT_PACKAGE}/skill`] }), []],
    ['test.optional', (root: string) => ({ root, extra: [] as string[] }), ['optional:', `  - path: "${ABSENT_PACKAGE}/skill"`]],
  ] as const)('skips an optional companion from %s that names nothing, with a warning', async (_label, argsFor, testLines) => {
    const { root } = declaredProject(testLines);
    const { extra } = argsFor(root);
    const run = await runSkillTest(root, [SKILL_NAME, ...extra]);
    expect(run.stderr).toContain('optional companion skill(s) not staged');
    expect(run.stderr).toContain('Reason: bootstrap');
    expect(run.error?.code).toBe('INPUT_UNREADABLE');
  });
});
