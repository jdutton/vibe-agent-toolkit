/* eslint-disable security/detect-non-literal-fs-filename -- All file paths are in temp directories controlled by tests */
/**
 * Integration tests for checkFilesConfigDests — tree-copy distribution awareness.
 *
 * Regression coverage for rc.11 Bug 1: `checkFilesConfigDests` was hard-coded to
 * check only `dist/skills/<name>/` (pool dir). Tree-copied skills land in the plugin
 * tree instead (`dist/.claude/plugins/marketplaces/<mp>/plugins/<plugin>/skills/<name>/`).
 * The old code reported false "missing dest" errors for tree-copy skills even when the
 * dest was present in the plugin tree.
 *
 * Test scenarios:
 *   (a) No false "missing dest" when dest is present in plugin tree, pool dir absent.
 *   (b) Genuinely absent dest in an existing plugin-tree dir is still flagged.
 */

import { writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { discoverSkillsFromConfig } from '../../src/commands/skills/skill-discovery.js';
import {
  checkFilesConfigDests,
  checkPackagedAgentInstructionFiles,
  type FilesDestCheckResult,
} from '../../src/commands/verify.js';
import { loadConfig } from '../../src/utils/config-loader.js';
import { createTempDirTracker } from '../system/test-common.js';

// ---------------------------------------------------------------------------
// The two phases under test take the run's DISCOVERED skills, so the tests wire
// discovery exactly as `vat verify` does. Passing a hand-written list here would
// make the fixture unable to distinguish "the phase enumerates what the project
// has" from "the phase enumerates what the test handed it" — which is the whole
// question these cases exist to answer.
// ---------------------------------------------------------------------------

async function discoveredIn(cwd: string): Promise<Awaited<ReturnType<typeof discoverSkillsFromConfig>>> {
  const config = loadConfig(cwd);
  return config?.skills ? discoverSkillsFromConfig(config.skills, cwd) : [];
}

const filesDestsIn = async (cwd: string): Promise<FilesDestCheckResult[]> =>
  checkFilesConfigDests(cwd, await discoveredIn(cwd));

const packagedContentIn = async (cwd: string): Promise<ReturnType<typeof checkPackagedAgentInstructionFiles>> =>
  checkPackagedAgentInstructionFiles(cwd, await discoveredIn(cwd));

// ---------------------------------------------------------------------------
// Fixture constants
// ---------------------------------------------------------------------------

const SKILL_NAME = 'my-test-skill';
const MARKETPLACE_NAME = 'test-marketplace';
const PLUGIN_NAME = 'test-plugin';
const DEST_FILE = 'built-artifact.js';
const CONFIG_FILE = 'vibe-agent-toolkit.config.yaml';

// ---------------------------------------------------------------------------
// Shared fixture helper
// ---------------------------------------------------------------------------

/**
 * Options controlling which parts of the fixture are created on disk.
 *
 * The config always declares:
 *   - `skills.config.<SKILL_NAME>.files`: one entry with dest = DEST_FILE
 *   - `claude.marketplaces.<MARKETPLACE_NAME>` with a tree-copy plugin (source + skills: [])
 *     when `includeTreeCopyPlugin` is true
 *
 * The plugin source's `skills/<SKILL_NAME>/` subdir is created only when
 * `createPluginSourceSkillDir` is true — `computeTreeCopiedSkillLocations` walks
 * this dir to discover tree-copy skill locations.
 */
interface FixtureOptions {
  /** Include a claude marketplace section with a tree-copy plugin (source + skills: []). */
  includeTreeCopyPlugin: boolean;
  /** Create the plugin source's skills/<SKILL_NAME>/ directory (needed for tree-copy discovery). */
  createPluginSourceSkillDir: boolean;
  /** Create the pool output dir dist/skills/<SKILL_NAME>/. */
  createPoolDir: boolean;
  /** Create the plugin-tree output dir for the skill. Requires createPluginSourceSkillDir. */
  createPluginTreeDir: boolean;
  /** Place DEST_FILE in the plugin-tree output dir. Requires createPluginTreeDir. */
  createDestInPluginTree: boolean;
  /** Place DEST_FILE in the pool output dir. Requires createPoolDir. */
  createDestInPool: boolean;
}

interface FixtureResult {
  /** Root of the temp dir (used as `cwd` for checkFilesConfigDests). */
  tempDir: string;
  /** Absolute path to the plugin-tree skill output dir (may or may not exist). */
  pluginOutputSkillDir: string;
  /** Absolute path to the pool skill output dir (may or may not exist). */
  poolOutputSkillDir: string;
}

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-verify-files-dests-');

/**
 * Create a temp dir with a synthetic tree-copy fixture for files-dests tests.
 *
 * The returned `tempDir` is registered with `createTempDirTracker` and cleaned
 * up in `afterEach` via `cleanupTempDirs()`.
 */
function setupFilesDestsFixture(opts: FixtureOptions): FixtureResult {
  const tempDir = createTempDir();

  // --- config file ---
  const claudeSection = opts.includeTreeCopyPlugin
    ? `claude:
  marketplaces:
    ${MARKETPLACE_NAME}:
      owner:
        name: Test Org
      plugins:
        - name: ${PLUGIN_NAME}
          description: Synthetic tree-copy plugin for files-dests testing
          source: plugins/${PLUGIN_NAME}
          skills: []
`
    : '';

  const configContent = `version: 1
skills:
  include:
    - "resources/skills/**/SKILL.md"
  config:
    ${SKILL_NAME}:
      files:
        - source: src/${DEST_FILE}
          dest: ${DEST_FILE}
${claudeSection}`;

  writeFileSync(safePath.join(tempDir, CONFIG_FILE), configContent, 'utf-8');

  // --- plugin source dir (read by computeTreeCopiedSkillLocations) ---
  if (opts.includeTreeCopyPlugin && opts.createPluginSourceSkillDir) {
    const pluginSourceSkillDir = safePath.join(
      tempDir, 'plugins', PLUGIN_NAME, 'skills', SKILL_NAME,
    );
    mkdirSyncReal(pluginSourceSkillDir, { recursive: true });
    // A SKILL.md isn't strictly required but mirrors real usage
    writeFileSync(
      safePath.join(pluginSourceSkillDir, 'SKILL.md'),
      `---\nname: ${SKILL_NAME}\ndescription: synthetic skill for tree-copy files-dests integration tests\n---\n`,
      'utf-8',
    );
  }

  // --- pool output dir ---
  const poolOutputSkillDir = safePath.join(tempDir, 'dist', 'skills', SKILL_NAME);
  if (opts.createPoolDir) {
    mkdirSyncReal(poolOutputSkillDir, { recursive: true });
    if (opts.createDestInPool) {
      writeFileSync(safePath.join(poolOutputSkillDir, DEST_FILE), 'built artifact', 'utf-8');
    }
  }

  // --- plugin-tree output dir ---
  const pluginOutputSkillDir = safePath.join(
    tempDir, 'dist', '.claude', 'plugins', 'marketplaces', MARKETPLACE_NAME,
    'plugins', PLUGIN_NAME, 'skills', SKILL_NAME,
  );
  if (opts.createPluginTreeDir) {
    mkdirSyncReal(pluginOutputSkillDir, { recursive: true });
    if (opts.createDestInPluginTree) {
      writeFileSync(safePath.join(pluginOutputSkillDir, DEST_FILE), 'built artifact', 'utf-8');
    }
  }

  return { tempDir, pluginOutputSkillDir, poolOutputSkillDir };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkFilesConfigDests (tree-copy distribution awareness)', () => {
  afterEach(() => {
    cleanupTempDirs();
  });

  // -------------------------------------------------------------------------
  // Scenario (a): tree-copy regression — no false "missing dest"
  // -------------------------------------------------------------------------

  describe('tree-copy plugin (source + skills: [])', () => {
    it('(a) does NOT report missing dest when dest is present in plugin tree and pool dir is absent', async () => {
      // rc.11 regression test.
      // Old code: always checked dist/skills/<name>/ — which does not exist for
      //   tree-copy builds — and reported false "missing dest".
      // Fixed code: no pool dir exists → not a candidate. Plugin-tree dir exists
      //   with dest file → candidate is satisfied → no missing dest.
      const { tempDir } = setupFilesDestsFixture({
        includeTreeCopyPlugin: true,
        createPluginSourceSkillDir: true, // computeTreeCopiedSkillLocations needs this
        createPoolDir: false,             // Tree-copy build never writes pool dir
        createPluginTreeDir: true,        // build writes here for tree-copy
        createDestInPluginTree: true,     // dest IS present
        createDestInPool: false,
      });

      const results = await filesDestsIn(tempDir);

      expect(results).toHaveLength(0);
    });

    it('(b) still flags genuinely absent dest in an existing plugin-tree dir', async () => {
      // True-positive: the plugin-tree dir exists but the dest file is NOT there.
      const { tempDir } = setupFilesDestsFixture({
        includeTreeCopyPlugin: true,
        createPluginSourceSkillDir: true,
        createPoolDir: false,
        createPluginTreeDir: true,         // dir exists → candidate
        createDestInPluginTree: false,     // dest ABSENT from candidate → missing
        createDestInPool: false,
      });

      const results = await filesDestsIn(tempDir);

      expect(results).toHaveLength(1);
      expect(results[0]?.missing).toContain(DEST_FILE);
    });

    it('does not report when neither pool dir nor plugin-tree dir exists (no candidate dirs)', async () => {
      // If build has not run yet, no candidate dirs → skip silently.
      const { tempDir } = setupFilesDestsFixture({
        includeTreeCopyPlugin: true,
        createPluginSourceSkillDir: true,
        createPoolDir: false,
        createPluginTreeDir: false,
        createDestInPluginTree: false,
        createDestInPool: false,
      });

      const results = await filesDestsIn(tempDir);

      expect(results).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Pool-model skill (no tree-copy plugin) — existing behaviour preserved
  // -------------------------------------------------------------------------

  describe('pool-only skill (no tree-copy plugin)', () => {
    it('reports missing dest when pool dir exists but dest is absent', async () => {
      const { tempDir } = setupFilesDestsFixture({
        includeTreeCopyPlugin: false,
        createPluginSourceSkillDir: false,
        createPoolDir: true,
        createPluginTreeDir: false,
        createDestInPluginTree: false,
        createDestInPool: false,          // dest absent from existing pool dir
      });

      const results = await filesDestsIn(tempDir);

      expect(results).toHaveLength(1);
      expect(results[0]?.missing).toContain(DEST_FILE);
    });

    it('does not report when pool dir exists and dest is present', async () => {
      const { tempDir } = setupFilesDestsFixture({
        includeTreeCopyPlugin: false,
        createPluginSourceSkillDir: false,
        createPoolDir: true,
        createPluginTreeDir: false,
        createDestInPluginTree: false,
        createDestInPool: true,           // dest present
      });

      const results = await filesDestsIn(tempDir);

      expect(results).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Error reporting quality: outputDir names the actual directory
  // -------------------------------------------------------------------------

  describe('error message quality', () => {
    it('result.outputDir is the plugin-tree dir, not a hard-coded dist/skills/... path', async () => {
      // Asserts that the error report names the real directory where the dest was expected.
      const { tempDir, pluginOutputSkillDir } = setupFilesDestsFixture({
        includeTreeCopyPlugin: true,
        createPluginSourceSkillDir: true,
        createPoolDir: false,
        createPluginTreeDir: true,        // candidate dir exists
        createDestInPluginTree: false,    // dest absent → will be reported
        createDestInPool: false,
      });

      const results = await filesDestsIn(tempDir);

      expect(results).toHaveLength(1);
      expect(results[0]?.outputDir).toBe(pluginOutputSkillDir);
    });

    it('result.outputDir is the pool dir for a pool-model skill', async () => {
      const { tempDir, poolOutputSkillDir } = setupFilesDestsFixture({
        includeTreeCopyPlugin: false,
        createPluginSourceSkillDir: false,
        createPoolDir: true,
        createPluginTreeDir: false,
        createDestInPluginTree: false,
        createDestInPool: false,          // dest absent → reported
      });

      const results = await filesDestsIn(tempDir);

      expect(results).toHaveLength(1);
      expect(results[0]?.outputDir).toBe(poolOutputSkillDir);
    });
  });
});

// ---------------------------------------------------------------------------
// B1: the built-bundle arm of PACKAGED_AGENT_INSTRUCTION_FILE
//
// `vat verify` reads the built dist/ tree by definition, so the crawl is
// unconditional here — no provenance question to answer, unlike `vat audit`.
// ---------------------------------------------------------------------------

/** A pool-only fixture with `rel` files written into the built bundle. */
function withPoolFiles(rel: string[]): string {
  const { tempDir, poolOutputSkillDir } = setupFilesDestsFixture({
    includeTreeCopyPlugin: false,
    createPluginSourceSkillDir: false,
    createPoolDir: true,
    createPluginTreeDir: false,
    createDestInPluginTree: false,
    createDestInPool: true,
  });
  for (const r of rel) {
    const full = safePath.join(poolOutputSkillDir, r);
    mkdirSyncReal(safePath.join(full, '..'), { recursive: true });
    writeFileSync(full, GUIDANCE_BYTES, 'utf-8');
  }
  return tempDir;
}

const GUIDANCE_BYTES = '# guidance\n';

describe('checkPackagedAgentInstructionFiles (built skill bundles)', () => {
  afterEach(() => {
    cleanupTempDirs();
  });

  it('reports an agent-instruction file at the bundle root', async () => {
    const issues = await packagedContentIn(withPoolFiles(['CLAUDE.md']));

    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('PACKAGED_AGENT_INSTRUCTION_FILE');
    expect(issues[0]?.location).toContain('CLAUDE.md');
  });

  it('reports one nested inside the bundle, which nothing links to', async () => {
    // The exact blindness B1 names: no link reaches it, so the link lane cannot
    // see it, and only a tree crawl can.
    const issues = await packagedContentIn(withPoolFiles(['notes/AGENTS.md']));

    expect(issues).toHaveLength(1);
    expect(issues[0]?.location).toContain('notes/AGENTS.md');
  });

  it('reports nothing for a clean bundle', async () => {
    await expect(packagedContentIn(withPoolFiles([]))).resolves.toEqual([]);
  });

  // §8.2: the config IS knowable here, so an explicit `files:` entry naming the
  // dest is honoured — the build put it there because config said to.
  it('does not report a dest an explicit files: entry declared', async () => {
    const { tempDir, poolOutputSkillDir } = setupFilesDestsFixture({
      includeTreeCopyPlugin: false,
      createPluginSourceSkillDir: false,
      createPoolDir: true,
      createPluginTreeDir: false,
      createDestInPluginTree: false,
      createDestInPool: true,
    });
    // Re-point the fixture's single explicit entry at an agent-instruction dest.
    writeFileSync(
      safePath.join(tempDir, CONFIG_FILE),
      `version: 1
skills:
  include:
    - "resources/skills/**/SKILL.md"
  config:
    ${SKILL_NAME}:
      files:
        - source: notes/CLAUDE.md
          dest: notes/CLAUDE.md
`,
      'utf-8',
    );
    mkdirSyncReal(safePath.join(poolOutputSkillDir, 'notes'), { recursive: true });
    writeFileSync(safePath.join(poolOutputSkillDir, 'notes', 'CLAUDE.md'), '# ok\n', 'utf-8');

    await expect(packagedContentIn(tempDir)).resolves.toEqual([]);
  });

  it('crawls the plugin-tree output dir too, not only the pool dir', async () => {
    const { tempDir, pluginOutputSkillDir } = setupFilesDestsFixture({
      includeTreeCopyPlugin: true,
      createPluginSourceSkillDir: true,
      createPoolDir: false,
      createPluginTreeDir: true,
      createDestInPluginTree: true,
      createDestInPool: false,
    });
    writeFileSync(safePath.join(pluginOutputSkillDir, 'CLAUDE.md'), GUIDANCE_BYTES, 'utf-8');

    const issues = await packagedContentIn(tempDir);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.location).toContain('CLAUDE.md');
  });

  it('reports nothing when no build output exists', async () => {
    const { tempDir } = setupFilesDestsFixture({
      includeTreeCopyPlugin: false,
      createPluginSourceSkillDir: false,
      createPoolDir: false,
      createPluginTreeDir: false,
      createDestInPluginTree: false,
      createDestInPool: false,
    });

    await expect(packagedContentIn(tempDir)).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Glob-discovered skills with no `skills.config` entry.
//
// The population both in-process phases were structurally blind to: a per-skill
// `config:` block is OPTIONAL, so the ordinary project — `skills.include` globs
// plus, at most, `skills.defaults` — had none of its bundles enumerated. Measured
// before the fix: `packaged-content` reported ONE finding for two bundles
// carrying an identical CLAUDE.md, and `files-config-dests` reported nothing at
// all for a `defaults.files` dest that was missing from every bundle — while the
// startup banner named both phases as having run.
// ---------------------------------------------------------------------------

/** A skill discovered only by the include glob — no `skills.config` entry. */
function writeDiscoverableSkill(tempDir: string, name: string): void {
  const dir = safePath.join(tempDir, 'resources', 'skills', name);
  mkdirSyncReal(dir, { recursive: true });
  writeFileSync(
    safePath.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: A skill discovered by glob for verify enumeration tests.\n---\n\n# ${name}\n`,
    'utf-8',
  );
}

/** Create `dist/skills/<name>/`, optionally with `rel` files written into it. */
function writeBundle(tempDir: string, name: string, rel: readonly string[]): string {
  const dir = safePath.join(tempDir, 'dist', 'skills', name);
  mkdirSyncReal(dir, { recursive: true });
  for (const r of rel) {
    const full = safePath.join(dir, r);
    mkdirSyncReal(safePath.join(full, '..'), { recursive: true });
    writeFileSync(full, GUIDANCE_BYTES, 'utf-8');
  }
  return dir;
}

const CONFIGURED = 'configured';
const PLAIN = 'plain';

/**
 * Two glob-discovered skills, exactly one of which has a `skills.config` entry.
 *
 * The discriminating fixture: with the enumeration keyed on `skills.config`,
 * `configured` is inspected and `plain` is not, so a phase that reports one
 * finding is reporting on membership in a config map rather than on the tree.
 */
function setupTwoSkillFixture(configBlock: string): string {
  const tempDir = createTempDir();
  writeFileSync(
    safePath.join(tempDir, CONFIG_FILE),
    `version: 1\nskills:\n  include:\n    - "resources/skills/**/SKILL.md"\n${configBlock}`,
    'utf-8',
  );
  writeDiscoverableSkill(tempDir, CONFIGURED);
  writeDiscoverableSkill(tempDir, PLAIN);
  return tempDir;
}

describe('in-process phases see skills the include globs discovered', () => {
  afterEach(() => {
    cleanupTempDirs();
  });

  it('reports the agent-instruction file in a bundle whose skill has no skills.config entry', async () => {
    const tempDir = setupTwoSkillFixture(
      `  config:\n    ${CONFIGURED}:\n      linkFollowDepth: 2\n`,
    );
    writeBundle(tempDir, CONFIGURED, ['CLAUDE.md']);
    writeBundle(tempDir, PLAIN, ['CLAUDE.md']);

    const locations = (await packagedContentIn(tempDir)).map((i) => String(i.location));

    expect(locations.some((l) => l.includes(`${CONFIGURED}/CLAUDE.md`))).toBe(true);
    expect(locations.some((l) => l.includes(`${PLAIN}/CLAUDE.md`))).toBe(true);
  });

  it('reports a skills.defaults.files dest missing from a bundle with no per-skill config block', async () => {
    const tempDir = setupTwoSkillFixture(
      '  defaults:\n    files:\n      - source: shared/tool.mjs\n        dest: scripts/tool.mjs\n',
    );
    // Both bundles were built; neither carries the default dest.
    writeBundle(tempDir, CONFIGURED, []);
    writeBundle(tempDir, PLAIN, []);

    const results = await filesDestsIn(tempDir);

    expect(results.map((r) => r.skillName).toSorted((a, b) => a.localeCompare(b)))
      .toEqual([CONFIGURED, PLAIN]);
    expect(results[0]?.missing).toEqual(['scripts/tool.mjs']);
  });

  it('still enumerates a skills.config key that discovery does not reach', async () => {
    // The union is not a replacement: a config key naming a skill the globs miss
    // (a renamed source, a stale entry) still points at a bundle sitting in dist/.
    const tempDir = setupTwoSkillFixture(
      '  config:\n    ghost:\n      files:\n        - source: src/a.js\n          dest: a.js\n',
    );
    writeBundle(tempDir, 'ghost', []);

    const results = await filesDestsIn(tempDir);

    expect(results.map((r) => r.skillName)).toEqual(['ghost']);
  });
});
