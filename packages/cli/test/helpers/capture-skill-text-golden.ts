/**
 * The one writer of the skill-text golden
 * (`packages/agent-skills/test/fixtures/skill-text-golden/golden.json`): the
 * capture ({@link captureSkillTextGolden}) run on a BUILT copy of the commit the
 * golden pins ({@link PINNED_COMMIT}), over this tree's corpus. The golden is
 * what that commit reported; it is never written from this tree's code, which
 * is what it tests.
 *
 * Adding a case: add its files to the corpus (a file with a NUL byte goes in
 * `writeSkillTextGolden`'s UTF-16LE table instead), then re-capture, from this
 * repository's root:
 *
 * ```sh
 * node_modules/.bin/tsx packages/cli/test/helpers/capture-skill-text-golden.ts
 * ```
 *
 * The script owns its copy: a shared clone of this repository at
 * {@link PINNED_COMMIT}, detached, in {@link CHECKOUT} under the OS temp
 * directory (never this tree, and no worktree or branch of it), installed and
 * built there once and reused on later runs; delete the directory to rebuild it.
 * Every tool is spawned by absolute path: git by `gitExecutable()`, bun (and
 * `tsc`, through `bun x`) by `resolveExecutable`. The calls below are that commit's signatures: a
 * golden re-pinned to a later commit adapts them here.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
import { normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';
import { gitExecutable, resolveExecutable } from '@vibe-agent-toolkit/utils/testing';

import { captureSkillTextGolden, type SkillsLane, type SkillsLaneRun } from './skill-text-golden-capture.js';
import { SKILL_TEXT_GOLDEN_DIR, writeSkillTextGoldenProject } from './skill-text-golden.js';

/** The commit the golden pins: a git ref, recorded in the document. */
const PINNED_COMMIT = 'c3236b26f';

/** Where the script builds {@link PINNED_COMMIT}: under the OS temp directory, named for the commit. */
const CHECKOUT = safePath.join(normalizedTmpdir(), `vat-skill-text-golden-${PINNED_COMMIT}`);

/** The last file the build writes that the capture loads: present means the copy is built. */
const BUILT_MARKER = 'packages/cli/dist/utils/logger.js';

/**
 * Clone this repository into {@link CHECKOUT} at {@link PINNED_COMMIT}, then
 * install and build the two packages the capture loads. Skipped when a build is
 * there; a partial copy from an interrupted run is removed and made again.
 */
function buildPinnedCommit(): void {
  if (existsSync(safePath.join(CHECKOUT, BUILT_MARKER))) return;
  rmSync(CHECKOUT, { recursive: true, force: true });
  const git = gitExecutable();
  const repository = execFileSync(git, ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();
  execFileSync(git, ['clone', '--quiet', '--shared', '--no-checkout', repository, CHECKOUT], { stdio: 'inherit' });
  execFileSync(git, ['checkout', '--quiet', '--detach', PINNED_COMMIT], { cwd: CHECKOUT, stdio: 'inherit' });
  const bun = resolveExecutable('bun');
  execFileSync(bun, ['install'], { cwd: CHECKOUT, stdio: 'inherit' });
  execFileSync(bun, ['x', 'tsc', '--build', 'packages/agent-skills', 'packages/cli'], { cwd: CHECKOUT, stdio: 'inherit' });
}

buildPinnedCommit();

/** A module of the pinned build: another tree's, typed by none of this one's declarations. */
const load = (path: string): Promise<any> => import(pathToFileURL(safePath.join(CHECKOUT, path)).href);
const agentSkills = await load('packages/agent-skills/dist/index.js');
const validate = await load('packages/cli/dist/commands/skills/validate.js');
const discovery = await load('packages/cli/dist/commands/skills/skill-discovery.js');
const runContext = await load('packages/cli/dist/utils/resource-loader.js');
const configLoader = await load('packages/cli/dist/utils/config-loader.js');
const packaging = await load('packages/cli/dist/utils/skill-packaging-config.js');
const loggerModule = await load('packages/cli/dist/utils/logger.js');

// Outside any OS temp directory: the skill-name check that compares a skill's name with its directory is
// skipped under the tmpdir, and the golden pins its findings.
const scratch = safePath.join(SKILL_TEXT_GOLDEN_DIR, '..', '..', '..', '.test-output', `skill-text-golden-capture-${process.pid}`);
const root = writeSkillTextGoldenProject(scratch);
const config = configLoader.loadConfig(root, 'source');
const logger = loggerModule.createLogger(false);
const { defaults, config: perSkill } = config.skills;

/** The checkout's skills lane, in its own signatures. */
const lane: SkillsLane = {
  root,
  withRun: (work) => runContext.withRunContext({ projectionStore: 'on-demand', root }, (run: { dispatcher: unknown }) => work({
    discover: () => discovery.discoverSkillsFromConfig(config.skills, root, 'refuse', run.dispatcher),
    sharedContext: (...[listed, discovered]: Parameters<SkillsLaneRun['sharedContext']>) => validate.buildSharedValidationContext(
      listed.map((skill) => ({ name: skill.discoveredName ?? '', sourcePath: skill.sourcePath, packagingConfig: skill.packagingConfig })),
      packaging.collectDeclaredEvalSuites(config.skills, discovered),
      config,
      logger,
      run,
    ),
    validateForPackaging: (...[skill, context]: Parameters<SkillsLaneRun['validateForPackaging']>) =>
      agentSkills.validateSkillForPackaging(skill.sourcePath, config.resources?.validation ?? {}, skill.packagingConfig, 'source', context),
    validateConfigFree: (skillPath: string) => agentSkills.validateSkill({
      skillPath, locationRoot: root, validation: {}, resourcesValidation: {}, side: 'source', dispatcher: run.dispatcher,
    }),
  })),
  packagingConfigOf: (name) => packaging.mergeSkillPackagingConfig(defaults, name === undefined ? undefined : perSkill?.[name]),
  readSkillName: (skillDir) => discovery.readPluginLocalSkillName(skillDir, undefined),
  // The checkout counts in its own modules, which this tree cannot read; the golden holds no counts.
  readCounters: () => ({}),
};

try {
  const { text } = await captureSkillTextGolden(lane, [root, scratch], PINNED_COMMIT);
  if (/\/Users\/|\/home\/|\/private\/|\/var\/folders|[A-Z]:\\\\/.test(text)) throw new Error('an absolute path leaked into the golden');
  const out = safePath.join(SKILL_TEXT_GOLDEN_DIR, 'golden.json');
  writeFileSync(out, text);
  console.log(`wrote ${out} from ${PINNED_COMMIT}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
