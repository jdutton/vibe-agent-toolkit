/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
/* eslint-disable sonarjs/file-permissions -- `chmod 000` on a throwaway temp path IS the fixture:
   the suites on this fixture prove a lane reports a path it could not read, and there is no way
   to produce one without setting the mode. Everything is under `mkdtemp` and restored before
   removal. */
/**
 * A plugin directory whose skills the filesystem refuses, or reaches only
 * through a symlink — the fixture BOTH compat lanes are held to.
 *
 * The settings checker and the compatibility analyzer each enumerate a plugin's
 * files themselves, and each used to lose the same population the same way: a
 * `Dirent` for a symlink answers `false` to `isFile()` and `isDirectory()`, and
 * one refused path either vanished (checker) or took the whole plugin down
 * (analyzer). One fixture, so the two suites assert the same layout and a
 * divergence between the lanes shows up as a difference in expectations, not
 * in what was built.
 */

import * as fs from 'node:fs/promises';

import { createSymlinkAsync, normalizedTmpdir, safePath, type SymlinkCapability } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll } from 'vitest';

/** `chmod 000` denies nothing to uid 0 and nothing on Windows. */
export const CANNOT_DENY_READS =
  process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0);

export const BASH_SKILL = (name: string): string =>
  `---\nname: ${name}\ndescription: declares Bash\nallowed-tools: Bash\n---\n# ${name}\n`;

export const SKILLS = 'skills';
export const PLAIN_SKILL = 'skills/plain/SKILL.md';
/** A skill directory reached only through a directory symlink under `skills/`. */
export const LINKED_DIR = 'linked-dir';
/** A skill whose `SKILL.md` is a file symlink to a shared markdown file. */
export const LINKED_FILE = 'linked-file';

/** The two symlinked skills' `SKILL.md` paths, plugin-relative and sorted. */
export const LINKED_SKILL_FILES = [`skills/${LINKED_DIR}/SKILL.md`, `skills/${LINKED_FILE}/SKILL.md`];

/** Write `dir/SKILL.md` (creating `dir`) and return the file's absolute path. */
export async function writeSkill(dir: string, content: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = safePath.join(dir, 'SKILL.md');
  await fs.writeFile(file, content, 'utf-8');
  return file;
}

export interface RefusedSkillFixture {
  /** The temp root; the plugin and any shared (symlink-target) trees live under it. */
  root: string;
  /** `<root>/plugin`, carrying `.claude-plugin/plugin.json` and an empty `skills/`. */
  pluginDir: string;
  /** `chmod 000` a path, restored before the fixture is removed. */
  lock(path: string): Promise<void>;
}

/**
 * Register a suite-scoped fixture: one temp root, one plugin with a manifest,
 * every locked path restored before teardown (`rm -rf` cannot remove a `000`
 * directory's contents).
 */
export function setupRefusedSkillFixture(prefix: string): () => RefusedSkillFixture {
  let fixture: RefusedSkillFixture | undefined;
  const locked: string[] = [];

  beforeAll(async () => {
    const root = await fs.mkdtemp(safePath.join(normalizedTmpdir(), prefix));
    const pluginDir = safePath.join(root, 'plugin');
    await fs.mkdir(safePath.join(pluginDir, SKILLS), { recursive: true });
    await fs.mkdir(safePath.join(pluginDir, '.claude-plugin'), { recursive: true });
    await fs.writeFile(
      safePath.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'refused-skills', version: '0.0.1' }),
      'utf-8',
    );
    fixture = {
      root,
      pluginDir,
      async lock(path: string): Promise<void> {
        await fs.chmod(path, 0o000);
        locked.push(path);
      },
    };
  });

  afterAll(async () => {
    for (const p of locked) await fs.chmod(p, 0o755).catch(() => undefined);
    if (fixture !== undefined) await fs.rm(fixture.root, { recursive: true, force: true });
  });

  return () => {
    if (fixture === undefined) throw new Error('refused-skill fixture used before beforeAll ran');
    return fixture;
  };
}

/**
 * A shared tree beside the plugin, each of its two Bash-declaring skills
 * reachable from `skills/` only through a symlink: {@link LINKED_DIR} as a
 * directory link, {@link LINKED_FILE} as a `SKILL.md` file link.
 */
export async function linkSharedSkills(cap: SymlinkCapability, { root, pluginDir }: RefusedSkillFixture): Promise<void> {
  const shared = safePath.join(root, 'shared');
  await writeSkill(safePath.join(shared, LINKED_DIR), BASH_SKILL(LINKED_DIR));
  const sharedFile = safePath.join(shared, 'linked-file.md');
  await fs.writeFile(sharedFile, BASH_SKILL(LINKED_FILE), 'utf-8');

  await createSymlinkAsync(cap, safePath.join(shared, LINKED_DIR), safePath.join(pluginDir, SKILLS, LINKED_DIR), 'dir');
  await fs.mkdir(safePath.join(pluginDir, SKILLS, LINKED_FILE), { recursive: true });
  await createSymlinkAsync(cap, sharedFile, safePath.join(pluginDir, SKILLS, LINKED_FILE, 'SKILL.md'), 'file');
}

/** A `skills/loop/back` link pointing at the plugin root — a cycle the walk must terminate on. */
export async function linkCycle(cap: SymlinkCapability, { pluginDir }: RefusedSkillFixture): Promise<void> {
  const loopDir = safePath.join(pluginDir, SKILLS, 'loop');
  await fs.mkdir(loopDir, { recursive: true });
  await createSymlinkAsync(cap, pluginDir, safePath.join(loopDir, 'back'), 'dir');
}
