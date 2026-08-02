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

import { checkFilesConfigDests, checkPackagedAgentInstructionFiles } from '../../src/commands/verify.js';
import { createTempDirTracker } from '../system/test-common.js';

// ---------------------------------------------------------------------------
// Fixture constants
// ---------------------------------------------------------------------------

const SKILL_NAME = 'my-test-skill';
const MARKETPLACE_NAME = 'test-marketplace';
const PLUGIN_NAME = 'test-plugin';
const DEST_FILE = 'built-artifact.js';

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

  writeFileSync(safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'), configContent, 'utf-8');

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
    it('(a) does NOT report missing dest when dest is present in plugin tree and pool dir is absent', () => {
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

      const results = checkFilesConfigDests(tempDir);

      expect(results).toHaveLength(0);
    });

    it('(b) still flags genuinely absent dest in an existing plugin-tree dir', () => {
      // True-positive: the plugin-tree dir exists but the dest file is NOT there.
      const { tempDir } = setupFilesDestsFixture({
        includeTreeCopyPlugin: true,
        createPluginSourceSkillDir: true,
        createPoolDir: false,
        createPluginTreeDir: true,         // dir exists → candidate
        createDestInPluginTree: false,     // dest ABSENT from candidate → missing
        createDestInPool: false,
      });

      const results = checkFilesConfigDests(tempDir);

      expect(results).toHaveLength(1);
      expect(results[0]?.missing).toContain(DEST_FILE);
    });

    it('does not report when neither pool dir nor plugin-tree dir exists (no candidate dirs)', () => {
      // If build has not run yet, no candidate dirs → skip silently.
      const { tempDir } = setupFilesDestsFixture({
        includeTreeCopyPlugin: true,
        createPluginSourceSkillDir: true,
        createPoolDir: false,
        createPluginTreeDir: false,
        createDestInPluginTree: false,
        createDestInPool: false,
      });

      const results = checkFilesConfigDests(tempDir);

      expect(results).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Pool-model skill (no tree-copy plugin) — existing behaviour preserved
  // -------------------------------------------------------------------------

  describe('pool-only skill (no tree-copy plugin)', () => {
    it('reports missing dest when pool dir exists but dest is absent', () => {
      const { tempDir } = setupFilesDestsFixture({
        includeTreeCopyPlugin: false,
        createPluginSourceSkillDir: false,
        createPoolDir: true,
        createPluginTreeDir: false,
        createDestInPluginTree: false,
        createDestInPool: false,          // dest absent from existing pool dir
      });

      const results = checkFilesConfigDests(tempDir);

      expect(results).toHaveLength(1);
      expect(results[0]?.missing).toContain(DEST_FILE);
    });

    it('does not report when pool dir exists and dest is present', () => {
      const { tempDir } = setupFilesDestsFixture({
        includeTreeCopyPlugin: false,
        createPluginSourceSkillDir: false,
        createPoolDir: true,
        createPluginTreeDir: false,
        createDestInPluginTree: false,
        createDestInPool: true,           // dest present
      });

      const results = checkFilesConfigDests(tempDir);

      expect(results).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Error reporting quality: outputDir names the actual directory
  // -------------------------------------------------------------------------

  describe('error message quality', () => {
    it('result.outputDir is the plugin-tree dir, not a hard-coded dist/skills/... path', () => {
      // Asserts that the error report names the real directory where the dest was expected.
      const { tempDir, pluginOutputSkillDir } = setupFilesDestsFixture({
        includeTreeCopyPlugin: true,
        createPluginSourceSkillDir: true,
        createPoolDir: false,
        createPluginTreeDir: true,        // candidate dir exists
        createDestInPluginTree: false,    // dest absent → will be reported
        createDestInPool: false,
      });

      const results = checkFilesConfigDests(tempDir);

      expect(results).toHaveLength(1);
      expect(results[0]?.outputDir).toBe(pluginOutputSkillDir);
    });

    it('result.outputDir is the pool dir for a pool-model skill', () => {
      const { tempDir, poolOutputSkillDir } = setupFilesDestsFixture({
        includeTreeCopyPlugin: false,
        createPluginSourceSkillDir: false,
        createPoolDir: true,
        createPluginTreeDir: false,
        createDestInPluginTree: false,
        createDestInPool: false,          // dest absent → reported
      });

      const results = checkFilesConfigDests(tempDir);

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

  it('reports an agent-instruction file at the bundle root', () => {
    const issues = checkPackagedAgentInstructionFiles(withPoolFiles(['CLAUDE.md']));

    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('PACKAGED_AGENT_INSTRUCTION_FILE');
    expect(issues[0]?.location).toContain('CLAUDE.md');
  });

  it('reports one nested inside the bundle, which nothing links to', () => {
    // The exact blindness B1 names: no link reaches it, so the link lane cannot
    // see it, and only a tree crawl can.
    const issues = checkPackagedAgentInstructionFiles(withPoolFiles(['notes/AGENTS.md']));

    expect(issues).toHaveLength(1);
    expect(issues[0]?.location).toContain('notes/AGENTS.md');
  });

  it('reports nothing for a clean bundle', () => {
    expect(checkPackagedAgentInstructionFiles(withPoolFiles([]))).toEqual([]);
  });

  // §8.2: the config IS knowable here, so an explicit `files:` entry naming the
  // dest is honoured — the build put it there because config said to.
  it('does not report a dest an explicit files: entry declared', () => {
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
      safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'),
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

    expect(checkPackagedAgentInstructionFiles(tempDir)).toEqual([]);
  });

  it('crawls the plugin-tree output dir too, not only the pool dir', () => {
    const { tempDir, pluginOutputSkillDir } = setupFilesDestsFixture({
      includeTreeCopyPlugin: true,
      createPluginSourceSkillDir: true,
      createPoolDir: false,
      createPluginTreeDir: true,
      createDestInPluginTree: true,
      createDestInPool: false,
    });
    writeFileSync(safePath.join(pluginOutputSkillDir, 'CLAUDE.md'), GUIDANCE_BYTES, 'utf-8');

    const issues = checkPackagedAgentInstructionFiles(tempDir);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.location).toContain('CLAUDE.md');
  });

  it('reports nothing when no build output exists', () => {
    const { tempDir } = setupFilesDestsFixture({
      includeTreeCopyPlugin: false,
      createPluginSourceSkillDir: false,
      createPoolDir: false,
      createPluginTreeDir: false,
      createDestInPluginTree: false,
      createDestInPool: false,
    });

    expect(checkPackagedAgentInstructionFiles(tempDir)).toEqual([]);
  });
});
