/**
 * `LINK_OUTSIDE_SKILL_DIR` for a PLUGIN-LOCAL skill (`plugins/<p>/skills/<s>/SKILL.md`).
 *
 * The pool lane raises it from its pre-build source validation; a plugin-local skill
 * gets no such pass, only `packageSkill`, so a skill configured `error` used to be
 * packaged — its out-of-directory target bundled and the link rewritten — with exit 0.
 * The plugin build must fail for it before the plugin is assembled, report it at
 * `warning`, and stay silent at the default `ignore`.
 */
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { runClaudePluginBuild } from '../../src/commands/claude/plugin/build.js';
import { cleanupTestTempDir, createTestTempDir, writeTestFile } from '../system/test-common.js';
import { commitTestFixture, silentLogger } from '../test-helpers.js';

const CODE = 'LINK_OUTSIDE_SKILL_DIR';
const STRICT = 'strict-skill';
const RELAXED = 'relaxed-skill';

function skillMd(name: string): string {
  return `---
name: ${name}
description: Synthetic plugin-local skill whose SKILL.md links a file outside its own directory.
---

# ${name}

See [shared notes](../shared.md).
`;
}

/** Writes and commits the fixture; `skillsBlock` is the YAML under `skills:` after `include`. */
function writeFixture(tempDir: string, skillsBlock: string): void {
  writeTestFile(safePath.join(tempDir, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0' }));
  writeTestFile(safePath.join(tempDir, '.gitignore'), 'dist/\n');
  writeTestFile(
    safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'),
    `version: 1
skills:
  include: ["plugins/*/skills/**/SKILL.md"]
${skillsBlock}
claude:
  marketplaces:
    mp:
      owner:
        name: Test Org
      plugins:
        - name: p
          description: Plugin with two plugin-local skills linking out of their directories
          skills: []
`,
  );
  const skills = safePath.join(tempDir, 'plugins', 'p', 'skills');
  for (const name of [STRICT, RELAXED]) mkdirSyncReal(safePath.join(skills, name), { recursive: true });
  writeTestFile(safePath.join(skills, 'shared.md'), '# Shared notes\n');
  writeTestFile(safePath.join(skills, STRICT, 'SKILL.md'), skillMd(STRICT));
  writeTestFile(safePath.join(skills, RELAXED, 'SKILL.md'), skillMd(RELAXED));
  commitTestFixture(tempDir);
}

/** `skills.config.<STRICT>` raising the code — keyed by the skill's declared name. */
function perSkillSeverity(severity: string): string {
  return `  config:\n    ${STRICT}:\n      validation:\n        severity:\n          ${CODE}: ${severity}`;
}

async function build(tempDir: string): Promise<{ lines: string[]; run: ReturnType<typeof runClaudePluginBuild> }> {
  const lines: string[] = [];
  const logger = { ...silentLogger, info: (m: string) => { lines.push(m); } };
  return { lines, run: runClaudePluginBuild(tempDir, { logger, verbose: true }) };
}

describe('plugin build — LINK_OUTSIDE_SKILL_DIR on plugin-local skills (integration)', () => {
  let tempDir: string;

  afterEach(() => {
    cleanupTestTempDir(tempDir);
  });

  it('fails the build for the one skill configured error, naming the code and that skill only', async () => {
    tempDir = createTestTempDir('vat-plugin-local-skilldir-error-');
    writeFixture(tempDir, perSkillSeverity('error'));

    const { lines, run } = await build(tempDir);

    // Only the strict skill is listed: the relaxed one links out too, at `ignore`.
    await expect(run).rejects.toThrow(/plugin-local skill\(s\) emitted .*: strict-skill$/);
    const report = lines.join('\n');
    expect(report).toContain(CODE);
    // Each finding's `Location:` names the linking SKILL.md; the relaxed skill's link is at `ignore`.
    expect(report).toContain(`${STRICT}/SKILL.md`);
    expect(report).not.toContain(`${RELAXED}/SKILL.md`);
  });

  it('fails the build when skills.defaults raises it to error', async () => {
    tempDir = createTestTempDir('vat-plugin-local-skilldir-defaults-');
    writeFixture(tempDir, `  defaults:\n    validation:\n      severity:\n        ${CODE}: error`);

    const { run } = await build(tempDir);

    await expect(run).rejects.toThrow(/plugin-local skill\(s\) emitted/);
  });

  it('reports it at warning and still builds', async () => {
    tempDir = createTestTempDir('vat-plugin-local-skilldir-warning-');
    writeFixture(tempDir, perSkillSeverity('warning'));

    const { lines, run } = await build(tempDir);
    const results = await run;

    expect(results[0]?.plugins[0]?.issueCounts.warnings).toBe(1);
    expect(lines.join('\n')).toContain(CODE);
  });

  it('stays silent at the default ignore', async () => {
    tempDir = createTestTempDir('vat-plugin-local-skilldir-ignore-');
    writeFixture(tempDir, '');

    const { lines, run } = await build(tempDir);
    const results = await run;

    expect(results[0]?.plugins[0]?.localSkillsPackaged).toBe(2);
    expect(results[0]?.plugins[0]?.issueCounts).toEqual({ errors: 0, warnings: 0, info: 0 });
    expect(lines.join('\n')).not.toContain(CODE);
  });
});
