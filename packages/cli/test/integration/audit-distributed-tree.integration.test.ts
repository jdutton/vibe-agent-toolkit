/* eslint-disable security/detect-non-literal-fs-filename -- all paths are temp dirs the test owns */
/**
 * B1: `vat audit` crawls a DISTRIBUTED skill tree for agent-instruction files.
 *
 * `PACKAGED_AGENT_INSTRUCTION_FILE` claims three surfaces — a built skill bundle,
 * an installed plugin, a plugin source directory — but the built-skill-bundle arm
 * had no producer at audit time. The skill lanes inspect SKILL.md plus whatever
 * links reach from it, so a file that arrives in a bundle with no link at all was
 * invisible: on a real adopter bundle carrying two of them, `vat audit` reported
 * `filesScanned: 1` and zero issues.
 *
 * The discriminator these tests pin is provenance, not path shape — and NOT the
 * project's config either. "The config does not declare this skill" was the
 * original discriminator and it was wrong in both of the ways a repository can
 * fail to adopt VAT: a repo with no config at all, and a repo whose `include`
 * globs simply do not enumerate every skill directory in the tree. Both are
 * source, and neither was ever handed to anyone. See
 * `classifyScannedSkillTree` for what replaced it.
 */

import { writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirTracker } from '../system/test-common.js';
import { commitTestFixture, initTestGitRepo, runAudit } from '../test-helpers.js';

const CODE = 'PACKAGED_AGENT_INSTRUCTION_FILE';
const SKILL_NAME = 'demo';
const CLAUDE_MD = 'CLAUDE.md';
/** The conventional pool directory a repo keeps its source skills in. */
const SKILLS_DIR = 'skills';
const PLUGIN_NAME = 'demo-plugin';
const PLUGIN_MANIFEST = JSON.stringify({
  name: PLUGIN_NAME,
  description: 'A synthetic plugin fixture.',
  version: '1.0.0',
});

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-audit-distributed-');

/** Every agent-instruction finding across a result set, by location. */
function instructionFindings(results: Awaited<ReturnType<typeof runAudit>>): string[] {
  return results
    .flatMap((r) => r.issues)
    .filter((i) => i.code === CODE)
    .map((i) => String(i.location))
    .sort((a, b) => a.localeCompare(b));
}

/** Write a minimal SKILL.md plus the given extra files under `dir`. */
function writeSkill(dir: string, extras: string[]): void {
  mkdirSyncReal(dir, { recursive: true });
  writeFileSync(
    safePath.join(dir, 'SKILL.md'),
    `---\nname: ${SKILL_NAME}\ndescription: A demonstration skill used to exercise distributed-tree auditing end to end.\n---\n\n# Demo\n\nBody.\n`,
    'utf-8',
  );
  for (const rel of extras) {
    const full = safePath.join(dir, rel);
    mkdirSyncReal(safePath.join(full, '..'), { recursive: true });
    writeFileSync(full, '# repo-internal guidance\n', 'utf-8');
  }
}

/** A plugin whose nested skill dir carries a CLAUDE.md. Returns both roots. */
function writePluginWithSkillGuidance(): { root: string; plugin: string } {
  const root = createTempDir();
  const plugin = safePath.join(root, 'plugins', PLUGIN_NAME);
  mkdirSyncReal(safePath.join(plugin, '.claude-plugin'), { recursive: true });
  writeFileSync(safePath.join(plugin, '.claude-plugin', 'plugin.json'), PLUGIN_MANIFEST, 'utf-8');
  writeSkill(safePath.join(plugin, SKILLS_DIR, SKILL_NAME), [CLAUDE_MD]);
  return { root, plugin };
}

/** A config whose `include` enumerates the `.claude/skills/` pool and nothing else. */
const CONFIG = `version: 1
skills:
  include:
    - ".claude/skills/**/SKILL.md"
`;

function writeVatConfig(root: string): void {
  writeFileSync(safePath.join(root, 'vibe-agent-toolkit.config.yaml'), CONFIG, 'utf-8');
}

describe('audit: distributed skill trees (integration)', () => {
  afterEach(() => {
    cleanupTempDirs();
  });

  it('reports agent-instruction files in a bundle no config declares', async () => {
    // The B1 population: a built bundle sitting beside the config that produced
    // it, in a tree that is not a git repository at all — output someone can ship,
    // with no working copy anywhere claiming it as source.
    const root = createTempDir();
    writeVatConfig(root);
    writeSkill(safePath.join(root, '.claude', SKILLS_DIR, SKILL_NAME), []);
    const bundle = safePath.join(root, 'dist', SKILLS_DIR, SKILL_NAME);
    writeSkill(bundle, [CLAUDE_MD, 'notes/AGENTS.md']);

    expect(instructionFindings(await runAudit(bundle))).toEqual([CLAUDE_MD, 'notes/AGENTS.md']);
  });

  // THE hard constraint. Guidance beside a source SKILL.md is deliberately fine.
  it('stays silent for a config-DECLARED source skill with a CLAUDE.md beside it', async () => {
    const root = createTempDir();
    writeVatConfig(root);
    const source = safePath.join(root, '.claude', SKILLS_DIR, SKILL_NAME);
    writeSkill(source, [CLAUDE_MD]);

    expect(instructionFindings(await runAudit(source))).toEqual([]);
  });

  it('reports one inside an installed plugin exactly once, not twice', async () => {
    // `validatePlugin` crawls the plugin tree at ANY depth, so the per-skill crawl
    // must stand down under a plugin or one file is counted twice — in two results,
    // in one run's issueCounts.
    const { plugin } = writePluginWithSkillGuidance();

    const findings = instructionFindings(await runAudit(plugin));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain(CLAUDE_MD);
  });

  it('reports it once when the plugin is reached by a recursive directory scan', async () => {
    // A different lane from the case above: scanning a repo ROOT descends into the
    // plugin dir and then finds the nested SKILL.md as an ordinary file entry. The
    // "a plugin ancestor already crawled this" flag has to survive that recursion,
    // not just the immediate child.
    const { root } = writePluginWithSkillGuidance();

    const findings = instructionFindings(await runAudit(root));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain(CLAUDE_MD);
  });

  it('reports nothing for a clean bundle', async () => {
    const root = createTempDir();
    const bundle = safePath.join(root, 'dist', SKILLS_DIR, SKILL_NAME);
    writeSkill(bundle, ['resources/guide.md', 'README.md']);

    expect(instructionFindings(await runAudit(bundle))).toEqual([]);
  });

  // The two false positives R5 closed. Both trees are ordinary repository source
  // that nobody handed to anybody, and both fired under the config-declaration
  // discriminator. The first one matters most: `vat audit` on a fresh repo is the
  // FIRST command a new user runs, and it greeted them with a warning telling them
  // to delete repo guidance that ships nowhere.
  describe('repository source is never a distributed tree', () => {
    it('stays silent for a tracked source skill in a repo with no VAT config at all', async () => {
      const root = createTempDir();
      writeSkill(safePath.join(root, SKILLS_DIR, SKILL_NAME), [CLAUDE_MD]);
      commitTestFixture(root);

      expect(instructionFindings(await runAudit(root))).toEqual([]);
    });

    it("stays silent for a tracked source skill the config's include globs do not match", async () => {
      // An adopting repo whose `include` enumerates `.claude/skills/**` still has
      // drafts, vendored copies and fixtures elsewhere in the tree. Not being
      // named by a glob is not evidence that a tree was published.
      const root = createTempDir();
      writeVatConfig(root);
      writeSkill(safePath.join(root, '.claude', SKILLS_DIR, SKILL_NAME), []);
      writeSkill(safePath.join(root, 'drafts', 'wip'), [CLAUDE_MD]);
      commitTestFixture(root);

      expect(instructionFindings(await runAudit(safePath.join(root, 'drafts', 'wip')))).toEqual([]);
    });

    it('stays silent for a brand-new skill the author has not committed yet', async () => {
      // Untracked-but-not-ignored is authoring in progress, not a distribution
      // artifact. Requiring a commit before a repo counts as source would make
      // the very first `vat audit` of a new skill the loudest one.
      const root = createTempDir();
      initTestGitRepo(root);
      writeSkill(safePath.join(root, SKILLS_DIR, SKILL_NAME), [CLAUDE_MD]);

      expect(instructionFindings(await runAudit(root))).toEqual([]);
    });
  });

  // The population the detector exists for. Each of these must still fire, and
  // each is a different reason for firing — none of them is "the config did not
  // mention it".
  describe('distributed trees still report', () => {
    it('reports a built bundle under a gitignored dist/ inside the repo', async () => {
      // `vat verify` reads dist by definition, and `vat audit <bundle>` must agree
      // with it. The bundle is INSIDE a git repo whose source is committed, so the
      // repo/no-repo question cannot answer this one — gitignored is what does.
      const root = createTempDir();
      writeFileSync(safePath.join(root, '.gitignore'), 'dist/\n', 'utf-8');
      writeSkill(safePath.join(root, SKILLS_DIR, SKILL_NAME), []);
      commitTestFixture(root);
      const bundle = safePath.join(root, 'dist', SKILLS_DIR, SKILL_NAME);
      writeSkill(bundle, [CLAUDE_MD]);

      expect(instructionFindings(await runAudit(bundle))).toEqual([CLAUDE_MD]);
    });

    it('reports an installed skill under the Claude install root even when it is tracked', async () => {
      // Claude Code installs marketplaces by `git clone`, so an installed tree's
      // files are TRACKED SOURCE of somebody else's repo — for a git-distributed
      // plugin, tracked source IS what ships. Tracked-ness therefore cannot be the
      // whole discriminator, and the install location has to win over it.
      const claudeDir = createTempDir();
      const installed = safePath.join(claudeDir, SKILLS_DIR, SKILL_NAME);
      writeSkill(installed, [CLAUDE_MD]);
      commitTestFixture(claudeDir);

      const previous = process.env['CLAUDE_CONFIG_DIR'];
      process.env['CLAUDE_CONFIG_DIR'] = claudeDir;
      try {
        expect(instructionFindings(await runAudit(installed))).toEqual([CLAUDE_MD]);
      } finally {
        if (previous === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
        else process.env['CLAUDE_CONFIG_DIR'] = previous;
      }
    });

    it('reports an unpacked bundle that lies outside any git repository', async () => {
      // A third-party tarball unpacked to disk: no repo, no config, no declaration
      // — and a `CLAUDE.md` that demonstrably travelled with the artifact.
      const unpacked = safePath.join(createTempDir(), SKILL_NAME);
      writeSkill(unpacked, [CLAUDE_MD]);

      expect(instructionFindings(await runAudit(unpacked))).toEqual([CLAUDE_MD]);
    });
  });
});
