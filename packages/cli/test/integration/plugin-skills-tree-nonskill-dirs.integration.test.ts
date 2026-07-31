/* eslint-disable security/detect-non-literal-fs-filename -- paths are test-owned temp dirs */
/**
 * Which directories under a plugin's `skills/` tree each build phase produces, and
 * which the verbatim tree-copy is left to ship.
 *
 * Three regressions are guarded here, all of the same shape — two phases disagreeing
 * about what a directory under `skills/` is:
 *
 *  1. **Content loss.** The tree-copy's exclusion list was once EVERY directory under
 *     `skills/`, while the packager only produced the ones holding a SKILL.md. A
 *     non-skill directory (`shared/`, `_templates/`) was excluded by one phase and
 *     skipped by the other — it shipped NOWHERE, with no diagnostic.
 *  2. **Answer-key leak + double production.** A NESTED skill
 *     (`skills/<group>/<skill>/SKILL.md`) was invisible to a non-recursive listing, so
 *     it fell to the verbatim tree-copy: its eval suite shipped (`expected_output`
 *     included), and when the same skill was ALSO selected from the pool it shipped a
 *     SECOND time at a different depth in the same plugin.
 *  3. **Publishing gitignored content.** The packager listed skill dirs with a raw
 *     `readdirSync` while the tree-copy honored git visibility, so a gitignored /
 *     untracked skill directory — content the author kept out of the repo, and which
 *     `vat skills build` never discovers — was packaged into the published bundle.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { mkdirSyncReal, safeExecSync, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { runClaudePluginBuild } from '../../src/commands/claude/plugin/build.js';
import type { Logger } from '../../src/utils/logger.js';
import { cleanupTestTempDir, createTestTempDir, writeTestFile } from '../system/test-common.js';

/** Build progress is irrelevant here; keep it out of the test output. */
const SILENT_LOGGER: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

const MARKETPLACE = 'mp';
const SKILLS_DIR = 'skills';
const SKILL_FILE = 'SKILL.md';

const PACKAGED_SKILL = 'real-skill';
const NESTED_SKILL = 'nested-skill';
const GITIGNORED_SKILL = 'wip-skill';
/** A pool-only skill: never present in the plugin's own skills/ tree. */
const POOL_ONLY_SKILL = 'pool-only-skill';
const PLUGIN = 'full-plugin';

/** Marker written into every eval suite; must never appear in a shipped bundle. */
const ANSWER_KEY = 'THE-EXPECTED-OUTPUT-ANSWER-KEY';

/** Minimal valid SKILL.md — no links, so the packaged output is just this file. */
function skillMd(name: string): string {
  return `---
name: ${name}
description: Synthetic fixture skill used to exercise plugin-local skill packaging.
---

# ${name}

Body text with no links, so nothing else is bundled.
`;
}

/** A skill dir plus a declared eval suite carrying the answer key. */
function writeSkillWithEvals(skillsDir: string, dirPath: string, name: string): void {
  const dir = safePath.join(skillsDir, dirPath);
  mkdirSyncReal(safePath.join(dir, 'evals'), { recursive: true });
  writeTestFile(safePath.join(dir, SKILL_FILE), skillMd(name));
  writeTestFile(
    safePath.join(dir, 'evals', 'evals.json'),
    JSON.stringify({ evals: [{ id: 'e1', prompt: 'do it', expected_output: ANSWER_KEY }] }),
  );
}

function configYaml(poolSelector: string): string {
  return `version: 1
skills:
  include: ["plugins/*/skills/**/SKILL.md"]
  config:
    ${PACKAGED_SKILL}:
      test:
        evals: evals/evals.json
    ${NESTED_SKILL}:
      test:
        evals: evals/evals.json
    ${GITIGNORED_SKILL}:
      test:
        evals: evals/evals.json
claude:
  marketplaces:
    ${MARKETPLACE}:
      owner:
        name: Test Org
      plugins:
        - name: ${PLUGIN}
          description: Plugin whose skills/ tree holds non-skill directories
          skills: ${poolSelector}
`;
}

/**
 * Write the fixture; returns the plugin's built output dir.
 *
 * `extra` runs against the plugin's `skills/` source dir BEFORE the fixture commits,
 * so anything it writes is git-tracked like the rest — discovery is tracked-files-only,
 * so a case that adds content afterwards would be testing invisibility by accident.
 */
function writeFixture(tempDir: string, poolSelector = '[]', extra?: (skillsDir: string) => void): string {
  writeTestFile(safePath.join(tempDir, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0' }));
  writeTestFile(safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'), configYaml(poolSelector));
  writeTestFile(
    safePath.join(tempDir, '.gitignore'),
    `dist/\nplugins/${PLUGIN}/${SKILLS_DIR}/${GITIGNORED_SKILL}/\n`,
  );

  const plugin = safePath.join(tempDir, 'plugins', PLUGIN);
  const skills = safePath.join(plugin, SKILLS_DIR);

  // A flat plugin-local skill and a NESTED one: the packager must produce both.
  writeSkillWithEvals(skills, PACKAGED_SKILL, PACKAGED_SKILL);
  writeSkillWithEvals(skills, `group/${NESTED_SKILL}`, NESTED_SKILL);
  // A gitignored skill: neither producer may ship it.
  writeSkillWithEvals(skills, GITIGNORED_SKILL, GITIGNORED_SKILL);

  // Two shapes that no phase packages, and which must therefore tree-copy.
  mkdirSyncReal(safePath.join(skills, 'shared'), { recursive: true });
  writeTestFile(safePath.join(skills, 'shared', 'helper.md'), '# Shared helper\n');
  mkdirSyncReal(safePath.join(skills, '_templates'), { recursive: true });
  writeTestFile(safePath.join(skills, '_templates', 'skeleton.md'), '# Skeleton\n');

  extra?.(skills);

  // Git visibility is the file set BOTH producers must agree on, so the fixture has
  // to be a real repo with a real commit — `.gitignore` alone proves nothing.
  safeExecSync('git', ['init', '-q', '-b', 'main'], { cwd: tempDir });
  safeExecSync('git', ['config', 'user.email', 'test@test'], { cwd: tempDir });
  safeExecSync('git', ['config', 'user.name', 'test'], { cwd: tempDir });
  safeExecSync('git', ['add', '-A'], { cwd: tempDir });
  safeExecSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: tempDir });

  return safePath.join(
    tempDir, 'dist', '.claude', 'plugins', 'marketplaces', MARKETPLACE, 'plugins', PLUGIN,
  );
}

/** Every file under `root`, as forward-slash paths relative to it. */
function walkFiles(root: string, prefix = ''): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const abs = safePath.join(root, entry.name);
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkFiles(abs, rel));
    else out.push(rel);
  }
  return out;
}

describe('plugin build — what each phase produces under skills/ (integration)', () => {
  let tempDir: string;

  afterEach(() => {
    cleanupTestTempDir(tempDir);
  });

  it('packages every skill (flat AND nested), tree-copies only non-skill dirs, and ships no answer key', async () => {
    tempDir = createTestTempDir('vat-plugin-skills-dirs-');
    const outDir = writeFixture(tempDir);

    const results = await runClaudePluginBuild(tempDir, { logger: SILENT_LOGGER });

    // Two skills packaged: the flat one and the NESTED one. The nested skill used to
    // be invisible to the packager and fell through to the verbatim tree-copy.
    const plugin = results[0]?.plugins[0];
    expect(plugin?.localSkillsPackaged).toBe(2);

    expect(existsSync(safePath.join(outDir, SKILLS_DIR, PACKAGED_SKILL, SKILL_FILE))).toBe(true);
    expect(existsSync(safePath.join(outDir, SKILLS_DIR, 'group', NESTED_SKILL, SKILL_FILE))).toBe(true);

    // The non-skill directories still ship — this is the content-loss regression.
    expect(existsSync(safePath.join(outDir, SKILLS_DIR, 'shared', 'helper.md'))).toBe(true);
    expect(existsSync(safePath.join(outDir, SKILLS_DIR, '_templates', 'skeleton.md'))).toBe(true);

    // No eval suite anywhere in the bundle, at any depth — the headline invariant.
    const shipped = walkFiles(outDir);
    expect(shipped.filter((p) => p.includes('/evals/'))).toEqual([]);
    for (const rel of shipped) {
      expect(readFileSync(safePath.join(outDir, rel), 'utf-8')).not.toContain(ANSWER_KEY);
    }
  });

  it('never ships a gitignored skill directory — the packager honors the same git visibility as the tree-copy', async () => {
    tempDir = createTestTempDir('vat-plugin-skills-gitignored-');
    const outDir = writeFixture(tempDir);

    const results = await runClaudePluginBuild(tempDir, { logger: SILENT_LOGGER });

    // Only the two tracked skills are packaged; the gitignored one is not a skill
    // this project publishes (`vat skills build` cannot discover it either).
    expect(results[0]?.plugins[0]?.localSkillsPackaged).toBe(2);
    expect(existsSync(safePath.join(outDir, SKILLS_DIR, GITIGNORED_SKILL))).toBe(false);
    expect(walkFiles(outDir).some((p) => p.includes(GITIGNORED_SKILL))).toBe(false);
  });

  it('refereeing a pool collision matches on the declared NAME, so a nested skill is not produced twice', async () => {
    tempDir = createTestTempDir('vat-plugin-skills-collision-');
    const outDir = writeFixture(tempDir, '"*"');

    // Stand in for `vat skills build` output: the pool copy the selector resolves to.
    const poolDist = safePath.join(tempDir, 'dist', 'skills', NESTED_SKILL);
    mkdirSyncReal(poolDist, { recursive: true });
    writeTestFile(safePath.join(poolDist, SKILL_FILE), skillMd(NESTED_SKILL));

    await runClaudePluginBuild(tempDir, { logger: SILENT_LOGGER });

    // The pool copy is the sole source; the plugin-local nested copy is neither
    // packaged nor tree-copied. Two definitions of one skill, at two depths in one
    // plugin, is exactly what the referee exists to prevent — and a dirname-only
    // comparison never saw this one, because `group` is not `nested-skill`.
    //
    // It lands at the skill's OWN authored path, not the default `skills/<fsName>`:
    // `DistributedSkillLocation.skillOutputDir` (and therefore `vat skill test` and
    // `vat verify`) says a plugin-local skill ships where it was authored, and that
    // has to hold whether the referee kept the local copy or the pool one. Landing
    // it at `skills/nested-skill` made `vat skill test nested-skill` hard-fail
    // looking for a dist at `skills/group/nested-skill` the build never wrote.
    expect(existsSync(safePath.join(outDir, SKILLS_DIR, 'group', NESTED_SKILL, SKILL_FILE))).toBe(true);
    expect(existsSync(safePath.join(outDir, SKILLS_DIR, NESTED_SKILL, SKILL_FILE))).toBe(false);
  });

  it('fails the build when two DIFFERENT skills claim one output directory', async () => {
    tempDir = createTestTempDir('vat-plugin-skills-dirclash-');

    // A plugin-local skill whose DIRECTORY leaf happens to match an unrelated pool
    // skill's name. Name-matching correctly says these are different skills, so the
    // referee has no winner to pick — but the packager and the pool copy-in would
    // both write `skills/<POOL_ONLY_SKILL>`. Matching the dir leaf as well as the
    // name used to "resolve" this by dropping the plugin-local skill silently: it
    // shipped NOWHERE, under a warning claiming it had been selected from the pool.
    writeFixture(tempDir, `["${POOL_ONLY_SKILL}"]`, (skillsDir) => {
      const clashDir = safePath.join(skillsDir, POOL_ONLY_SKILL);
      mkdirSyncReal(clashDir, { recursive: true });
      writeTestFile(safePath.join(clashDir, SKILL_FILE), skillMd('a-different-skill'));
    });

    // Stand in for `vat skills build` output: the pool copy the selector resolves to.
    const poolDist = safePath.join(tempDir, 'dist', 'skills', POOL_ONLY_SKILL);
    mkdirSyncReal(poolDist, { recursive: true });
    writeTestFile(safePath.join(poolDist, SKILL_FILE), skillMd(POOL_ONLY_SKILL));

    await expect(runClaudePluginBuild(tempDir, { logger: SILENT_LOGGER })).rejects.toThrow(
      /two DIFFERENT skills claim the same output directory/,
    );
  });

  it('warns — rather than silently dropping — when a skill dir exists but git does not track it', async () => {
    tempDir = createTestTempDir('vat-plugin-skills-untracked-');
    writeFixture(tempDir);

    // Created AFTER the fixture's commit: never `git add`ed, and not gitignored.
    // Tracked-files-only discovery is correct (the tree-copy has always worked that
    // way), but a build that reports success while omitting a skill the author can
    // see on disk reads as one that shipped it.
    const brandNew = safePath.join(tempDir, 'plugins', PLUGIN, SKILLS_DIR, 'brand-new');
    mkdirSyncReal(brandNew, { recursive: true });
    writeTestFile(safePath.join(brandNew, SKILL_FILE), skillMd('brand-new'));

    const warnings: string[] = [];
    await runClaudePluginBuild(tempDir, {
      logger: { ...SILENT_LOGGER, info: (m: string) => { warnings.push(m); } },
    });

    expect(warnings.some((m) => m.includes('skills/brand-new/SKILL.md') && m.includes('not tracked by git'))).toBe(true);
    // The deliberately GITIGNORED skill gets no such warning — ignoring it IS the
    // instruction, and warning every build would train authors to ignore warnings.
    expect(warnings.some((m) => m.includes(GITIGNORED_SKILL) && m.includes('not tracked by git'))).toBe(false);
  });
});
