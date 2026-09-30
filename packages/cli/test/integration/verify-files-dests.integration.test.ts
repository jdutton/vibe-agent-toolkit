/**
 * Integration tests for `vat verify`'s `files-config-dests` phase — tree-copy
 * distribution awareness — driven through `runFilesConfigDestsPhase`, the
 * function the command itself runs, and read off the report it publishes.
 *
 * Regression coverage for rc.11 Bug 1: the dest check was hard-coded to
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

import { indexPluginLocalSkills, type PluginLocalSkillIndex } from '@vibe-agent-toolkit/agent-skills';
import type { Finding, ValidationIssue } from '@vibe-agent-toolkit/schema';
import { mkdirSyncReal, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import {
  discoverSkillsFromConfig,
  readPluginLocalSkillNames,
  type PluginLocalSkillNames,
} from '../../src/commands/skills/skill-discovery.js';
import {
  checkPackagedAgentInstructionFiles,
  runFilesConfigDestsPhase,
} from '../../src/commands/verify.js';
import { loadConfig } from '../../src/utils/config-loader.js';
import { createTempDirTracker } from '../system/test-common.js';
import { silentLogger } from '../test-doubles.js';

// ---------------------------------------------------------------------------
// The two phases under test take the run's DISCOVERED skills, so the tests wire
// discovery exactly as `vat verify` does. Passing a hand-written list here would
// make the fixture unable to distinguish "the phase enumerates what the project
// has" from "the phase enumerates what the test handed it" — which is the whole
// question these cases exist to answer.
// ---------------------------------------------------------------------------

async function discoveredIn(cwd: string): Promise<Awaited<ReturnType<typeof discoverSkillsFromConfig>>> {
  const config = loadConfig(cwd);
  return config?.skills ? discoverSkillsFromConfig(config.skills, cwd, 'refuse') : [];
}

/** The plugin-local index `vat verify` builds for `cwd`, and the declared names it reads for it. */
async function pluginLocalIn(cwd: string): Promise<[PluginLocalSkillIndex, PluginLocalSkillNames]> {
  const index = indexPluginLocalSkills(loadConfig(cwd) ?? { version: 1 }, cwd);
  return [index, await readPluginLocalSkillNames(index)];
}

/** The `files-config-dests` phase's report over `cwd`: how many bundles it checked, and its findings. */
async function filesDestsIn(cwd: string): Promise<{ examined: number; findings: Finding[] }> {
  const { report } = runFilesConfigDestsPhase(cwd, await discoveredIn(cwd), ...(await pluginLocalIn(cwd)), silentLogger);
  return { examined: report.examined, findings: report.findings };
}

/** Where a finding for `dest` missing from the bundle at `outputDir` is located: project-relative. */
const destLocation = (cwd: string, outputDir: string, dest = DEST_FILE): string =>
  toForwardSlash(safePath.relative(cwd, safePath.join(outputDir, dest)));

/** The locations of the phase's findings over `cwd` — one per missing dest. */
const missingIn = async (cwd: string): Promise<string[]> =>
  (await filesDestsIn(cwd)).findings.map((finding) => String(finding.location));

const packagedCrawlIn = async (cwd: string): Promise<ReturnType<typeof checkPackagedAgentInstructionFiles>> =>
  checkPackagedAgentInstructionFiles(cwd, await discoveredIn(cwd), ...(await pluginLocalIn(cwd)));

/** The crawl's findings alone; the bundle count beside them is pinned where it matters. */
const packagedContentIn = async (cwd: string): Promise<ValidationIssue[]> =>
  (await packagedCrawlIn(cwd)).issues;

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
  /** Root of the temp dir (the project root the phase runs over). */
  tempDir: string;
  /** Absolute path to the plugin-tree skill output dir (may or may not exist). */
  pluginOutputSkillDir: string;
  /** Absolute path to the pool skill output dir (may or may not exist). */
  poolOutputSkillDir: string;
}

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-verify-files-dests-');

/**
 * A project whose plugin-local skill `name` lives in `skills/<dir>`, discovered by
 * `include`, with `files:` declared under `skills.config.<configKey>`. Returns the
 * plugin-tree output dir, created empty.
 */
function planted(opts: { name: string; dir: string; include: string; configKey: string }): { tempDir: string; outputDir: string } {
  const tempDir = createTempDir();
  writeFileSync(
    safePath.join(tempDir, CONFIG_FILE),
    `version: 1
skills:
  include: ["${opts.include}"]
  config:
    ${opts.configKey}:
      files:
        - source: src/${DEST_FILE}
          dest: ${DEST_FILE}
claude:
  marketplaces:
    ${MARKETPLACE_NAME}:
      owner:
        name: Test Org
      plugins:
        - name: ${PLUGIN_NAME}
          skills: []
`,
    'utf-8',
  );
  const sourceDir = safePath.join(tempDir, 'plugins', PLUGIN_NAME, 'skills', opts.dir);
  mkdirSyncReal(sourceDir, { recursive: true });
  writeFileSync(safePath.join(sourceDir, 'SKILL.md'), `---\nname: ${opts.name}\ndescription: fixture\n---\n`, 'utf-8');
  const outputDir = safePath.join(
    tempDir, 'dist', '.claude', 'plugins', 'marketplaces', MARKETPLACE_NAME, 'plugins', PLUGIN_NAME, 'skills', opts.dir,
  );
  mkdirSyncReal(outputDir, { recursive: true });
  return { tempDir, outputDir };
}

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

describe('the files-config-dests phase (tree-copy distribution awareness)', () => {
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

      // One bundle checked — the plugin-tree copy — and nothing missing.
      expect(await filesDestsIn(tempDir)).toEqual({ examined: 1, findings: [] });
    });

    it('(b) still flags genuinely absent dest in an existing plugin-tree dir', async () => {
      // True-positive: the plugin-tree dir exists but the dest file is NOT there.
      const { tempDir, pluginOutputSkillDir } = setupFilesDestsFixture({
        includeTreeCopyPlugin: true,
        createPluginSourceSkillDir: true,
        createPoolDir: false,
        createPluginTreeDir: true,         // dir exists → candidate
        createDestInPluginTree: false,     // dest ABSENT from candidate → missing
        createDestInPool: false,
      });

      // The whole finding: the code, at error (never overridable), located at
      // the path the dest should be, relative to the project root.
      expect(await filesDestsIn(tempDir)).toEqual({
        examined: 1,
        findings: [{
          code: 'FILES_CONFIG_DEST_MISSING',
          severity: 'error',
          message: `Skill '${SKILL_NAME}' declares the files: dest '${DEST_FILE}', and the built output does not hold it.`,
          location: destLocation(tempDir, pluginOutputSkillDir),
          fix: 'Run `vat build` so the files: entry is applied, or correct the entry\'s dest in vibe-agent-toolkit.config.yaml.',
        }],
      });
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

      // Nothing built, so nothing checked: `examined` says so (the
      // packaged-content phase names the unbuilt bundle).
      expect(await filesDestsIn(tempDir)).toEqual({ examined: 0, findings: [] });
    });
  });

  it('reads a plugin-tree copy\'s files: from skills.config.<declared name>, not from its directory name', async () => {
    // The skill's directory (`shipped-dir`) is not named after it (`shipped`), so a
    // directory-keyed lookup finds no `files:` and reports nothing missing.
    const tempDir = createTempDir();
    writeFileSync(
      safePath.join(tempDir, CONFIG_FILE),
      `version: 1
skills:
  include: ["plugins/*/skills/**/SKILL.md"]
  config:
    shipped:
      files:
        - source: src/${DEST_FILE}
          dest: ${DEST_FILE}
claude:
  marketplaces:
    ${MARKETPLACE_NAME}:
      owner:
        name: Test Org
      plugins:
        - name: ${PLUGIN_NAME}
          skills: []
`,
      'utf-8',
    );
    const sourceDir = safePath.join(tempDir, 'plugins', PLUGIN_NAME, 'skills', 'shipped-dir');
    mkdirSyncReal(sourceDir, { recursive: true });
    writeFileSync(safePath.join(sourceDir, 'SKILL.md'), '---\nname: shipped\ndescription: skill whose dir is not its name\n---\n', 'utf-8');
    const outputDir = safePath.join(
      tempDir, 'dist', '.claude', 'plugins', 'marketplaces', MARKETPLACE_NAME, 'plugins', PLUGIN_NAME, 'skills', 'shipped-dir',
    );
    mkdirSyncReal(outputDir, { recursive: true });

    expect(await missingIn(tempDir)).toEqual([destLocation(tempDir, outputDir)]);
  });

  describe('a plugin-tree copy\'s config is looked up exactly as the plugin build looks it up', () => {
    it('by declared name even when no include glob reaches the skill — the build still names it', async () => {
      const { tempDir, outputDir } = planted({ name: 'shipped', dir: 'shipped-dir', include: 'elsewhere/**/SKILL.md', configKey: 'shipped' });

      expect(await missingIn(tempDir)).toEqual([destLocation(tempDir, outputDir)]);
    });

    it('by directory when no key carries its declared name — the build applies that entry, so verify checks it', async () => {
      const { tempDir, outputDir } = planted({ name: 'foo', dir: 'bar', include: 'plugins/*/skills/**/SKILL.md', configKey: 'bar' });

      expect(await missingIn(tempDir)).toEqual([destLocation(tempDir, outputDir)]);
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

      const { examined, findings } = await filesDestsIn(tempDir);

      expect(examined).toBe(1);
      expect(findings.map((finding) => [finding.code, finding.severity])).toEqual([['FILES_CONFIG_DEST_MISSING', 'error']]);
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

      expect(await filesDestsIn(tempDir)).toEqual({ examined: 1, findings: [] });
    });
  });

  // -------------------------------------------------------------------------
  // Error reporting quality: outputDir names the actual directory
  // -------------------------------------------------------------------------

  describe('where a finding points', () => {
    it('at the plugin-tree dir, not a hard-coded dist/skills/... path', async () => {
      // Asserts that the error report names the real directory where the dest was expected.
      const { tempDir, pluginOutputSkillDir } = setupFilesDestsFixture({
        includeTreeCopyPlugin: true,
        createPluginSourceSkillDir: true,
        createPoolDir: false,
        createPluginTreeDir: true,        // candidate dir exists
        createDestInPluginTree: false,    // dest absent → will be reported
        createDestInPool: false,
      });

      expect(await missingIn(tempDir)).toEqual([destLocation(tempDir, pluginOutputSkillDir)]);
    });

    it('at the pool dir for a pool-model skill', async () => {
      const { tempDir, poolOutputSkillDir } = setupFilesDestsFixture({
        includeTreeCopyPlugin: false,
        createPluginSourceSkillDir: false,
        createPoolDir: true,
        createPluginTreeDir: false,
        createDestInPluginTree: false,
        createDestInPool: false,          // dest absent → reported
      });

      expect(await missingIn(tempDir)).toEqual([destLocation(tempDir, poolOutputSkillDir)]);
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

  it('reports no finding and ZERO bundles when no build output exists', async () => {
    // The crawl itself stays honest: nothing found, over nothing. Refusing that
    // as a verdict is the phase builder's job (`buildPackagedContentPhase`),
    // which is why the count travels with the findings.
    const { tempDir } = setupFilesDestsFixture({
      includeTreeCopyPlugin: false,
      createPluginSourceSkillDir: false,
      createPoolDir: false,
      createPluginTreeDir: false,
      createDestInPluginTree: false,
      createDestInPool: false,
    });

    // `skills.config.<name>` alone expects nothing: discovery reached no skill,
    // so nothing was built and nothing is missing — the stale key is the
    // consistency phase's finding, not this one's.
    await expect(packagedCrawlIn(tempDir)).resolves.toEqual({
      bundlesInspected: 0,
      bundlesExpected: 0,
      bundlesInPlace: 0,
      bundlesMissing: [],
      issues: [],
    });
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

    const { examined } = await filesDestsIn(tempDir);

    expect(examined).toBe(2);
    expect((await missingIn(tempDir)).toSorted((a, b) => a.localeCompare(b))).toEqual([
      `dist/skills/${CONFIGURED}/scripts/tool.mjs`,
      `dist/skills/${PLAIN}/scripts/tool.mjs`,
    ]);
  });

  it('counts as examined only the built bundles that declare a files: dest', async () => {
    // Both bundles are built; only `configured` declares a dest. The bundle with
    // nothing to check is not "checked and clean" — counting it would inflate
    // the denominator the orchestrator sums.
    const tempDir = setupTwoSkillFixture(
      `  config:\n    ${CONFIGURED}:\n      files:\n        - source: src/a.js\n          dest: a.js\n`,
    );
    writeBundle(tempDir, CONFIGURED, ['a.js']);
    writeBundle(tempDir, PLAIN, []);

    expect(await filesDestsIn(tempDir)).toEqual({ examined: 1, findings: [] });
  });

  it('still enumerates a skills.config key that discovery does not reach', async () => {
    // The union is not a replacement: a config key naming a skill the globs miss
    // (a renamed source, a stale entry) still points at a bundle sitting in dist/.
    const tempDir = setupTwoSkillFixture(
      '  config:\n    ghost:\n      files:\n        - source: src/a.js\n          dest: a.js\n',
    );
    writeBundle(tempDir, 'ghost', []);

    expect(await missingIn(tempDir)).toEqual(['dist/skills/ghost/a.js']);
  });
});
