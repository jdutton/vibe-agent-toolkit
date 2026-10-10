/**
 * The build / package / clear verb family, as fault-matrix cases: `vat skills build`,
 * `vat skills package`, `vat agent build`, `vat claude plugin build`, `vat build`,
 * `vat rag clear`, `vat cache clear`, `vat claude marketplace publish` (its publish-tree
 * lane), `vat skill test configure` and `vat agent import`.
 *
 * Each case builds one project under the case root (`r.project`), with any previous output
 * the verb replaces, and names the atomic units the verb writes: each must end byte-equal to
 * BEFORE or to GOLDEN. The whole project is watched, so a write anywhere else is seen.
 *
 * Test code: raw `fs` is fine here.
 */

// Before anything that loads a command: the refusal path's seam for invariant I8.
import '../refusal-observer.js';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import type { SnapshotRewrite } from '@vibe-agent-toolkit/utils/testing';
import type { Command } from 'commander';
import * as YAML from 'yaml';

import { createAgentCommand } from '../../../src/commands/agent/index.js';
import { createBuildTopLevelCommand } from '../../../src/commands/build.js';
import { createCacheCommand } from '../../../src/commands/cache/index.js';
import { createMarketplaceCommand } from '../../../src/commands/claude/marketplace/index.js';
import { createPluginCommand } from '../../../src/commands/claude/plugin/index.js';
import { createRagCommand } from '../../../src/commands/rag/index.js';
import { createSkillCommand } from '../../../src/commands/skill/index.js';
import { createSkillsCommand } from '../../../src/commands/skills/index.js';
import type { CaseRoot, VerbCase } from '../drive.js';
import type { MatrixShard } from '../matrix.js';

import { prefixed, PUBLISHED_TREE_CAPTURE, skillMd, writeTree, type TreeFile } from './tree-files.js';
import { zipWithoutEntryTimes } from './zip-times.js';

const MP = 'fx-mp';
const PLUGIN = 'fx-plugin';
const SKILL = 'fx-skill';
const AGENT = 'fx-agent';
const VERSION = '1.0.0';
const PRIOR = '0.9.0';
const CONFIG_FILE = 'vibe-agent-toolkit.config.yaml';

/** A key relative to the case root, of a path under the project. */
const projectKey = (path: string): string => `project/${path}`;

// --- the project ---------------------------------------------------------------------------

/** The pool skill: a SKILL.md that links a reference, so the packager bundles two files. */
const SKILL_FILES: readonly TreeFile[] = [
  ['SKILL.md', skillMd(SKILL, `${VERSION}\n\nSee [notes](references/notes.md).`)],
  ['references/notes.md', '# Notes\n\nnotes\n'],
];

interface ProjectShape {
  /** `claude.marketplaces.<mp>.publish`, for the publish-tree case. */
  publish?: boolean;
}

function projectConfig(shape: ProjectShape): string {
  const publish = shape.publish === true ? { publish: { changelog: 'CHANGELOG.md', readme: 'README.md', license: 'MIT' } } : {};
  return YAML.stringify({
    skills: { include: ['skills/**/SKILL.md'] },
    claude: { marketplaces: { [MP]: { owner: { name: 'fx' }, plugins: [{ name: PLUGIN, description: 'A fixture plugin', skills: [SKILL] }], ...publish } } },
  });
}

/** The project's own sources: config, package.json, the pool skill and the plugin's own dir. */
function writeProject(r: CaseRoot, shape: ProjectShape = {}): void {
  writeTree(r.project, [
    [CONFIG_FILE, projectConfig(shape)],
    ['package.json', JSON.stringify({ name: '@fx/fx-project', version: VERSION })],
    ...prefixed(`skills/${SKILL}`, SKILL_FILES),
    [`plugins/${PLUGIN}/commands/hello.md`, '# hello\n'],
  ]);
}

/** What a previous `vat skills build` left in `dist/skills`. */
function writePriorSkillsBuild(r: CaseRoot, body: string): void {
  writeTree(safePath.join(r.project, 'dist', 'skills', SKILL), [['SKILL.md', skillMd(SKILL, body)], ['resources/notes.md', '# Notes\n\nprior\n']]);
}

const marketplaceDir = 'dist/.claude/plugins/marketplaces/' + MP;

/** What a previous `vat claude plugin build` left in `dist/.claude/plugins/marketplaces/<mp>`. */
function writePriorMarketplace(r: CaseRoot): void {
  writeTree(safePath.join(r.project, marketplaceDir), [
    ['.claude-plugin/marketplace.json', JSON.stringify({ name: MP, owner: { name: 'fx' }, plugins: [{ name: PLUGIN, source: `./plugins/${PLUGIN}`, version: PRIOR }] })],
    [`plugins/${PLUGIN}/.claude-plugin/plugin.json`, JSON.stringify({ name: PLUGIN, version: PRIOR })],
    [`plugins/${PLUGIN}/skills/${SKILL}/SKILL.md`, skillMd(SKILL, PRIOR)],
  ]);
}

/** What every project case reads and must never change, relative to the project. */
const PROJECT_SOURCES = ['skills', 'plugins', 'package.json', CONFIG_FILE] as const;

/**
 * The project-root files the claude phase copies into every marketplace (`copyDistributionFiles`):
 * inputs it probes whether or not the fixture writes them, so a refused probe is on the source side.
 */
const DISTRIBUTION_FILES = ['LICENSE', 'README.md', 'CHANGELOG.md'] as const;

/** The project's sources (all of {@link PROJECT_SOURCES}, or the ones named) as paths. */
const projectSources = (r: CaseRoot, names: readonly string[] = PROJECT_SOURCES): string[] => names.map((name) => safePath.join(r.project, name));

interface ProjectCase {
  id: string;
  group: () => Command;
  argv: (r: CaseRoot) => readonly string[];
  /** Prior state beyond the project's sources. */
  prior?: (r: CaseRoot) => void;
  shape?: ProjectShape;
  units: readonly string[];
  /** The trees the verb reads, when not {@link projectSources}. */
  sources?: (r: CaseRoot) => readonly string[];
  rewrites?: readonly SnapshotRewrite[];
  /** See {@link VerbCase.composite}. */
  composite?: true;
  /** See {@link VerbCase.shapeFromSource}. */
  shapeFromSource?: true;
  /** See {@link VerbCase.packagingFinding}. */
  packagingFinding?: true;
  /** See {@link VerbCase.presencePreflight}. */
  presencePreflight?: VerbCase['presencePreflight'];
}

/**
 * A verb that packages skills through `packageSkill`: it classifies a write into a bundle with
 * `shapeFromSource` (the skill's `files:` layout decides it), and publishes a packager's
 * source-side fault as the `SKILL_PACKAGING_FAILED` finding.
 */
const PACKAGES_SKILLS = { shapeFromSource: true, packagingFinding: true } as const;

/** A case run in the project, watching all of it. */
function projectCase(spec: ProjectCase): VerbCase {
  return {
    id: spec.id,
    group: spec.group,
    argv: spec.argv,
    fixture: (r) => {
      writeProject(r, spec.shape);
      spec.prior?.(r);
    },
    watched: (r) => [r.project],
    units: () => spec.units.map(projectKey),
    sources: (r) => spec.sources?.(r) ?? projectSources(r),
    cwd: (r) => r.project,
    ...(spec.rewrites === undefined ? {} : { rewrites: () => spec.rewrites ?? [] }),
    ...(spec.composite === undefined ? {} : { composite: spec.composite }),
    ...(spec.shapeFromSource === undefined ? {} : { shapeFromSource: spec.shapeFromSource }),
    ...(spec.packagingFinding === undefined ? {} : { packagingFinding: spec.packagingFinding }),
    ...(spec.presencePreflight === undefined ? {} : { presencePreflight: spec.presencePreflight }),
  };
}

const ZIP_TIMES: SnapshotRewrite = { applies: (key) => key.endsWith('.zip'), rewriteBytes: zipWithoutEntryTimes };

// --- `vat skills build` / `vat claude plugin build` / `vat build` ----------------------------

/** `vat skills build` over a previous build: `dist/skills` is replaced as one unit. */
function skillsBuildCase(): VerbCase {
  return projectCase({
    id: 'skills/build',
    ...PACKAGES_SKILLS,
    group: () => createSkillsCommand(),
    argv: () => ['build'],
    prior: (r) => writePriorSkillsBuild(r, PRIOR),
    units: ['dist/skills'],
  });
}

/** `vat claude plugin build` over a previous marketplace, from a `dist/skills` already built. */
function pluginBuildCase(): VerbCase {
  return projectCase({
    id: 'plugin/build',
    ...PACKAGES_SKILLS,
    group: () => createPluginCommand(),
    argv: () => ['build'],
    prior: (r) => {
      writePriorSkillsBuild(r, VERSION);
      writePriorMarketplace(r);
    },
    units: [marketplaceDir],
    sources: (r) => [...projectSources(r), ...projectSources(r, DISTRIBUTION_FILES), safePath.join(r.project, 'dist', 'skills')],
  });
}

/** `vat build`: the skills phase, then the claude phase, over a previous build of both. */
function topLevelBuildCase(): VerbCase {
  return projectCase({
    id: 'top-level-build',
    ...PACKAGES_SKILLS,
    group: () => createBuildTopLevelCommand(),
    // `vat build` folds its phases' reports into one RUN_INCOMPLETE: the failed phase's refusal is the one judged.
    composite: true,
    argv: () => [],
    prior: (r) => {
      writePriorSkillsBuild(r, PRIOR);
      writePriorMarketplace(r);
    },
    units: ['dist/skills', marketplaceDir],
    sources: (r) => [...projectSources(r), ...projectSources(r, DISTRIBUTION_FILES)],
  });
}

// --- `vat skills package` ------------------------------------------------------------------

type PackageVariant = 'o-fresh' | 'o-force' | 'o-occupied';

/** The `-o` the package cases write, and the archives the zip and marketplace formats put beside it. */
const PACKAGE_OUT = 'out/fx-skill';
const PACKAGE_UNITS = [PACKAGE_OUT, `${PACKAGE_OUT}.zip`, `out/${SKILL}.marketplace.json`] as const;

/** What a previous `vat skills package -o out/fx-skill` left: the directory and both archives beside it. */
function writePriorPackage(r: CaseRoot): void {
  writeTree(safePath.join(r.project, 'out'), [
    ...prefixed(SKILL, [['SKILL.md', skillMd(SKILL, PRIOR)], ['resources/notes.md', 'prior\n']]),
    [`${SKILL}.zip`, 'a previous archive'],
    [`${SKILL}.marketplace.json`, JSON.stringify({ name: SKILL, version: PRIOR })],
  ]);
}

/** `vat skills package <skill> -o out/fx-skill` (directory, zip and marketplace formats): fresh, `--force` over a previous package, or into an empty directory. */
function skillsPackageCase(variant: PackageVariant): VerbCase {
  return projectCase({
    id: `skills/package/${variant}`,
    ...PACKAGES_SKILLS,
    group: () => createSkillsCommand(),
    argv: (r) => [
      'package', safePath.join(r.project, 'skills', SKILL, 'SKILL.md'), '-o', safePath.join(r.project, PACKAGE_OUT),
      '--formats', 'directory,zip,marketplace', ...(variant === 'o-force' ? ['--force'] : []),
    ],
    prior: (r) => {
      if (variant === 'o-force') writePriorPackage(r);
      if (variant === 'o-occupied') mkdirSyncReal(safePath.join(r.project, PACKAGE_OUT), { recursive: true });
    },
    units: PACKAGE_UNITS,
    rewrites: [ZIP_TIMES],
  });
}

// --- `vat agent build` / `vat agent import` ------------------------------------------------

const AGENT_MANIFEST = `metadata:\n  name: ${AGENT}\n  version: ${VERSION}\n  description: Reviews fixtures\n`
  + 'spec:\n  llm:\n    provider: anthropic\n    model: claude-sonnet-5\n  prompts:\n    system:\n      $ref: ./prompts/system.md\n';

/** The agent's output: `--output out` builds into `out/<agent>`. */
const AGENT_OUT = `out/${AGENT}`;

/** `vat agent build <agent> --output out`: fresh, or `--force` over a previous build. */
function agentBuildCase(variant: 'output' | 'force'): VerbCase {
  return projectCase({
    id: `agent/build/${variant}`,
    ...PACKAGES_SKILLS,
    group: () => createAgentCommand(),
    argv: (r) => ['build', safePath.join(r.project, 'agent'), '--output', safePath.join(r.project, 'out'), ...(variant === 'force' ? ['--force'] : [])],
    prior: (r) => {
      writeTree(safePath.join(r.project, 'agent'), [['agent.yaml', AGENT_MANIFEST], ['prompts/system.md', 'You review fixtures.\n']]);
      if (variant === 'force') writeTree(safePath.join(r.project, AGENT_OUT), [['SKILL.md', skillMd(AGENT, PRIOR)], ['scripts/old.js', '// prior\n']]);
    },
    units: [AGENT_OUT],
    sources: (r) => [...projectSources(r), safePath.join(r.project, 'agent')],
  });
}

/** `vat agent import <SKILL.md>`: writes `agent.yaml` beside the skill. */
function agentImportCase(): VerbCase {
  return projectCase({
    id: 'agent/import',
    group: () => createAgentCommand(),
    argv: (r) => ['import', safePath.join(r.project, 'skills', SKILL, 'SKILL.md')],
    units: [`skills/${SKILL}/agent.yaml`],
    // The skill's own files, not its directory: agent.yaml is written into it.
    sources: (r) => projectSources(r, [...PROJECT_SOURCES.filter((name) => name !== 'skills'), ...SKILL_FILES.map(([path]) => `skills/${SKILL}/${path}`)]),
  });
}

// --- `vat skill test configure` ------------------------------------------------------------

/** `vat skill test configure fx-skill --max-turns 5`: rewrites the project config in place. */
function skillTestConfigureCase(): VerbCase {
  return projectCase({
    id: 'skill/test/configure',
    group: () => createSkillCommand(),
    argv: () => ['test', 'configure', SKILL, '--max-turns', '5'],
    units: [CONFIG_FILE],
    sources: (r) => projectSources(r, PROJECT_SOURCES.filter((name) => name !== CONFIG_FILE)),
    // Configure first checks the project HAS a config: "none there" is CONFIG_INVALID, whatever made it absent.
    presencePreflight: (r) => ({ path: safePath.join(r.project, CONFIG_FILE), refusal: 'CONFIG_INVALID' }),
  });
}

// --- `vat claude marketplace publish` (the publish-tree lane) ------------------------------

/**
 * `vat claude marketplace publish` over a built marketplace: the publish tree composed under
 * $TMPDIR. The git lane (`publishToGitBranch`) spawns git, so `publish-tree-git-mock.ts` stands in
 * for it; every traced fs call left is the composer's. The stand-in keeps the tree it was handed
 * (untraced) at {@link PUBLISHED_TREE_CAPTURE}, which is this case's unit: a run that exits 0 must
 * have published exactly what the uninjected run publishes — a composer that dropped a file under a
 * fault and still listed the marketplace as published is I3's to catch.
 */
function marketplacePublishTreeCase(): VerbCase {
  return projectCase({
    id: 'marketplace/publish-tree',
    group: () => createMarketplaceCommand(),
    argv: () => ['publish', '--no-push'],
    shape: { publish: true },
    prior: (r) => {
      writePriorMarketplace(r);
      writeTree(r.project, [['CHANGELOG.md', `# Changelog\n\n## [Unreleased]\n\n- a change\n`], ['README.md', '# fx\n']]);
    },
    units: [PUBLISHED_TREE_CAPTURE],
    sources: (r) => [...projectSources(r), ...['dist', 'CHANGELOG.md', 'README.md'].map((path) => safePath.join(r.project, path))],
  });
}

// --- `vat rag clear` / `vat cache clear` ---------------------------------------------------

/** A database `vat rag index` made, as far as `rag clear` can tell: both tables' directories, a few files each. */
const RAG_DATABASE: readonly TreeFile[] = ['rag_chunks', 'rag_documents'].flatMap((table): TreeFile[] => [
  [`${table}.lance/_versions/1.manifest`, 'manifest'],
  [`${table}.lance/_transactions/0-a.txn`, 'txn'],
  [`${table}.lance/data/a.lance`, 'data a'],
  [`${table}.lance/data/b.lance`, 'data b'],
]);

/** `vat rag clear`: the project's `.rag-db`, or `--db` naming one elsewhere in the project. */
function ragClearCase(variant: 'default' | 'db'): VerbCase {
  const db = variant === 'default' ? '.rag-db' : 'indexes/fx-db';
  return projectCase({
    id: `rag/clear/${variant}`,
    group: () => createRagCommand(),
    argv: (r) => ['clear', ...(variant === 'db' ? ['--db', safePath.join(r.project, db)] : [])],
    prior: (r) => writeTree(safePath.join(r.project, db), RAG_DATABASE),
    units: [db],
  });
}

/**
 * `vat cache clear`: the whole `$TMPDIR/.vat-cache` tree, files at every level. ONE directory per
 * level: `fs.promises.rm` lists sibling directories concurrently, so with two the order of their
 * listings in the trace (and so which one an injection picks) changes from run to run.
 */
function cacheClearCase(): VerbCase {
  return {
    id: 'cache/clear',
    group: () => createCacheCommand(),
    argv: () => ['clear'],
    fixture: (r) => writeTree(safePath.join(r.tmp, '.vat-cache'), [
      ['external-links.json', '{}'],
      ['fx-namespace/projection.db', 'db'],
      ['fx-namespace/parse/aa/facts.json', '{}'],
      ['fx-namespace/parse/aa/more-facts.json', '{}'],
    ]),
    watched: (r) => [r.tmp],
    units: () => ['tmp/.vat-cache'],
    sources: () => [],
  };
}

// --- the shard table -----------------------------------------------------------------------

/**
 * Every build-family case, and how many matrix files share its injections: each file holds the
 * injections with `shardOf(id, files) === index`, which must fit the shard limit (C10).
 * `fault-matrix-shards.integration.test.ts` holds each file to this table.
 */
export const BUILD_FAMILY_SHARDS = {
  'skills/build': { make: skillsBuildCase, files: 17 },
  'skills/package/o-fresh': { make: () => skillsPackageCase('o-fresh'), files: 10 },
  'skills/package/o-force': { make: () => skillsPackageCase('o-force'), files: 14 },
  'skills/package/o-occupied': { make: () => skillsPackageCase('o-occupied'), files: 12 },
  'agent/build/output': { make: () => agentBuildCase('output'), files: 10 },
  'agent/build/force': { make: () => agentBuildCase('force'), files: 9 },
  'plugin/build': { make: pluginBuildCase, files: 11 },
  'top-level-build': { make: topLevelBuildCase, files: 30 },
  'rag/clear/default': { make: () => ragClearCase('default'), files: 3 },
  'rag/clear/db': { make: () => ragClearCase('db'), files: 3 },
  'cache/clear': { make: cacheClearCase, files: 3 },
  'marketplace/publish-tree': { make: marketplacePublishTreeCase, files: 6 },
  'skill/test/configure': { make: skillTestConfigureCase, files: 2 },
  'agent/import': { make: agentImportCase, files: 2 },
} as const satisfies Readonly<Record<string, MatrixShard>>;
