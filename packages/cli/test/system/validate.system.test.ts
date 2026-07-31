/**
 * System tests for the top-level `vat validate` command.
 *
 * `vat validate` runs every validator the project's config declares — and only
 * those. Surfaces are discovered from vibe-agent-toolkit.config.yaml, so a
 * project with no `skills:` block does not run skill validation, and vice
 * versa. It is source-level only and never inspects built dist artifacts.
 */

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';
import * as YAML from 'yaml';

import {
  createSkillMarkdown,
  createSkillsConfigYaml,
  createTempDirTracker,
  executeCli,
  getBinPath,
  writeTestFile,
} from './test-common.js';

const TEMP_DIR_PREFIX = 'vat-validate-test-';
const VAT_CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';
const SKILL_INCLUDE_GLOB = 'resources/skills/**/SKILL.md';
const SKILL_SOURCE_PATH = safePath.join('resources', 'skills', 'SKILL.md');
const SUCCESS_MARKER = 'status: success';
/** A markdown file with nothing for the resources validator to complain about. */
const CLEAN_MARKDOWN = '# Title\n\nNo links here.\n';

/** A minimal resources config block (presence is what enables the surface). */
const RESOURCES_CONFIG = `version: 1
resources:
  exclude:
    - "node_modules/**"
`;

function setupValidateTestSuite() {
  const binPath = getBinPath(import.meta.url);
  const { createTempDir, cleanupTempDirs } = createTempDirTracker(TEMP_DIR_PREFIX);

  const writeConfig = (dir: string, content: string) =>
    writeTestFile(safePath.join(dir, VAT_CONFIG_FILENAME), content);

  const writeSkillSource = (dir: string, skillName: string) => {
    mkdirSyncReal(safePath.join(dir, 'resources', 'skills'), { recursive: true });
    writeTestFile(safePath.join(dir, SKILL_SOURCE_PATH), createSkillMarkdown(skillName));
  };

  const runValidate = (dir: string, extraArgs: string[] = []) =>
    executeCli(binPath, ['--cwd', dir, 'validate', ...extraArgs]);

  return { createTempDir, cleanupTempDirs, writeConfig, writeSkillSource, runValidate };
}

describe('vat validate command (system test)', () => {
  const suite = setupValidateTestSuite();

  afterEach(() => {
    suite.cleanupTempDirs();
  });

  it('runs the resources surface when only resources is configured', async () => {
    const tempDir = suite.createTempDir();
    suite.writeConfig(tempDir, RESOURCES_CONFIG);
    writeTestFile(safePath.join(tempDir, 'README.md'), CLEAN_MARKDOWN);

    const result = await suite.runValidate(tempDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(SUCCESS_MARKER);
    expect(result.stdout).toContain('resources');
    // skills surface must not run when no skills block is present
    expect(result.stdout).not.toContain('name: skills');
  });

  it('runs the skills surface when only skills is configured', async () => {
    const tempDir = suite.createTempDir();
    suite.writeConfig(tempDir, createSkillsConfigYaml([SKILL_INCLUDE_GLOB]));
    suite.writeSkillSource(tempDir, 'test-skill');

    const result = await suite.runValidate(tempDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(SUCCESS_MARKER);
    expect(result.stdout).toContain('skills');
  });

  it('discovers configured surfaces when run from a subdirectory', async () => {
    // Regression: config must be read from the resolved project root, not the
    // invocation cwd — otherwise a subdirectory run finds no config and falsely
    // passes with "No configured validators".
    const tempDir = suite.createTempDir();
    suite.writeConfig(tempDir, RESOURCES_CONFIG);
    writeTestFile(safePath.join(tempDir, 'README.md'), CLEAN_MARKDOWN);
    const subDir = safePath.join(tempDir, 'packages', 'foo');
    mkdirSyncReal(subDir, { recursive: true });

    const result = await suite.runValidate(subDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('name: resources');
    expect(result.stdout).not.toContain('No configured validators');
  });

  it('reports a no-op note and a stderr warning when no surface is configured', async () => {
    // Exit 0 is correct here (nothing configured is not an error per #128), but
    // a bare exit-code check can't distinguish this from "everything passed" —
    // the stderr warning is what makes a config typo (e.g. `recources:`)
    // discoverable to anyone not reading the YAML note on stdout.
    const tempDir = suite.createTempDir();
    suite.writeConfig(tempDir, 'version: 1\n');

    const result = await suite.runValidate(tempDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(SUCCESS_MARKER);
    expect(result.stdout).toContain('No configured validators');
    expect(result.stderr).toContain('nothing to validate');
  });

  it('fails the retired --only with an explanation, not Commander\'s unknown-option error', async () => {
    const tempDir = suite.createTempDir();
    suite.writeConfig(tempDir, RESOURCES_CONFIG);

    // End-to-end because the contract is a WIRING one and no unit can see it:
    // the flag has to still be declared on the command for our message to be
    // the one that prints. Delete the hidden Option and every unit test here
    // still passes while the real CLI regresses to `unknown option '--only'`.
    const result = await suite.runValidate(tempDir, ['--only', 'skills']);

    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain('unknown option');
    expect(result.stderr).toContain("'--only' was removed");
    expect(result.stderr).toContain('vat build --only');
  });

  it('does not advertise the retired --only in help', async () => {
    // Hidden on purpose: a retired flag is not a feature to discover, and
    // listing it would imply it still selects something.
    const result = await suite.runValidate(suite.createTempDir(), ['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('--only <');
  });

  it('emits ONE parseable YAML document even when several surfaces run', async () => {
    // The defect: each child's document was streamed straight onto this
    // command's stdout with no `---` between them, so two surfaces produced a
    // single map carrying `status:` and `durationSecs:` twice over and
    // `YAML.parse()` threw "Map keys must be unique at line 7".
    // `vat validate | jq` — which this command's own help recommends — had
    // never worked. A bare `toContain('status: success')` could not see it:
    // that substring was present the whole time.
    const tempDir = suite.createTempDir();
    suite.writeConfig(
      tempDir,
      `${RESOURCES_CONFIG}skills:\n  include:\n    - "${SKILL_INCLUDE_GLOB}"\n`,
    );
    writeTestFile(safePath.join(tempDir, 'README.md'), CLEAN_MARKDOWN);
    suite.writeSkillSource(tempDir, 'test-skill');

    const result = await suite.runValidate(tempDir);

    const parsed = YAML.parse(result.stdout) as {
      status: string;
      phases: Array<{ name: string; report?: { status?: string } }>;
    };

    expect(parsed.phases.map((p) => p.name)).toEqual(['resources', 'skills']);
    // Each validator's own report survives as data under its own surface —
    // which is exactly what a flat concatenation could not represent.
    expect(parsed.phases[0]?.report?.status).toBeDefined();
    expect(parsed.phases[1]?.report?.status).toBeDefined();
  });

  it('exits exactly 1 — not 2 — when a configured validator reports validation errors', async () => {
    const tempDir = suite.createTempDir();
    // resources configured with a markdown file containing a broken internal link
    suite.writeConfig(tempDir, RESOURCES_CONFIG);
    writeTestFile(safePath.join(tempDir, 'README.md'), '# Title\n\n[broken](./does-not-exist.md)\n');

    const result = await suite.runValidate(tempDir);

    // `not.toBe(0)` cannot express this: exit 1 (a validator found problems) and
    // exit 2 (a validator could not run) are different facts for a CI gate, and
    // the surface status must say which one happened.
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('status: error');
    expect(result.stdout).toContain('exitCode: 1');
    expect(result.stdout).not.toContain('system-error');
  });
});
