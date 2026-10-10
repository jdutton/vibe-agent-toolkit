/**
 * The install / uninstall verb family, as fault-matrix cases: `vat claude plugin install`
 * (every lane), `vat claude plugin uninstall`, `vat skills install`, `vat agent install`
 * and `vat agent uninstall`.
 *
 * Each case builds its own inputs and prior state under the case root, names the atomic
 * units the verb replaces (each must end byte-equal to BEFORE or to GOLDEN), and, where the
 * verb keeps a registry, which units the registry names after the run (I7).
 *
 * Test code: raw `fs` is fine here.
 */

// Before anything that loads a command: the refusal path's seam for invariant I8.
import '../refusal-observer.js';

import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

import { VAT_MARKETPLACE_MARKER } from '@vibe-agent-toolkit/claude-marketplace';
import { isPathAbsentError, mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { createSymlink, type StatRewrite, symlinkCapability, tmpdirFoldsCase } from '@vibe-agent-toolkit/utils/testing';
import type { Command } from 'commander';
import { vi } from 'vitest';

import { createAgentCommand } from '../../../src/commands/agent/index.js';
import { downloadNpmPackage } from '../../../src/commands/claude/plugin/helpers.js';
import { createPluginCommand } from '../../../src/commands/claude/plugin/index.js';
import { createSkillsCommand } from '../../../src/commands/skills/index.js';
import { extractTarballSync } from '../../../src/utils/archive-staging.js';
import { CommandRefusalError } from '../../../src/utils/command-refusal.js';
import { tarballOf } from '../../helpers/tarball.js';
import { writeZipFixture } from '../../helpers/zip-fixtures.js';
import type { CaseRoot, VerbCase } from '../drive.js';
import type { MatrixShard } from '../matrix.js';

import { prefixed, skillMd, writeTree, type TreeFile } from './tree-files.js';

const MP = 'fx-mp';
const PLUGIN = 'fx-plugin';
const SKILL = 'fx-skill';
const PACKAGE = '@fx/fx-pkg';
const VERSION = '1.0.0';
const PRIOR_VERSION = '0.9.0';
/** The plugin `vat.replaces` names, installed before the run. */
const OLD_PLUGIN = 'fx-old-plugin';
/** The legacy flat skill `vat.replaces` names, installed before the run. */
const LEGACY_SKILL = 'fx-legacy-skill';
/** A case-only respelling of {@link PLUGIN}: one directory on APFS / NTFS, two elsewhere. */
const ALIASED_PLUGIN = 'FX-PLUGIN';
const AGENT = 'fx-agent';

/** A plugin's own files, as its built tree and its installed copies hold them. */
function pluginFiles(name: string, body: string): TreeFile[] {
  return [
    ['.claude-plugin/plugin.json', JSON.stringify({ name, version: body })],
    [`skills/${SKILL}/SKILL.md`, skillMd(SKILL, body)],
  ];
}

const marketplaceJson = (plugins: readonly string[]): TreeFile => [
  '.claude-plugin/marketplace.json',
  JSON.stringify({ name: MP, owner: { name: 'fx' }, plugins: plugins.map((name) => ({ name, source: `./plugins/${name}` })) }),
];

interface PackageShape {
  replaces?: { plugins?: string[]; flatSkills?: string[] };
}

/** A VAT npm package: package.json, its built plugin tree, and its built flat skill (what `--dev` links). */
function packageFiles(shape: PackageShape = {}): TreeFile[] {
  const vat = shape.replaces === undefined ? {} : { vat: { replaces: shape.replaces } };
  return [
    ['package.json', JSON.stringify({ name: PACKAGE, version: VERSION, ...vat })],
    ...prefixed(`dist/.claude/plugins/marketplaces/${MP}`, [marketplaceJson([PLUGIN]), ...prefixed(`plugins/${PLUGIN}`, pluginFiles(PLUGIN, VERSION))]),
    [`dist/skills/${SKILL}/SKILL.md`, skillMd(SKILL, VERSION)],
  ];
}

// --- prior state under ~/.claude -------------------------------------------------------

const claudeDir = (r: CaseRoot): string => safePath.join(r.home, '.claude');
const pluginsDir = (r: CaseRoot): string => safePath.join(claudeDir(r), 'plugins');

/** The registry files Claude Code reads, as keys relative to the case root. */
const REGISTRY_KEYS = [
  'home/.claude/plugins/known_marketplaces.json',
  'home/.claude/plugins/installed_plugins.json',
  'home/.claude/settings.json',
] as const;

const marketplaceKey = 'home/.claude/plugins/marketplaces/' + MP;
const cacheKey = (plugin: string): string => `home/.claude/plugins/cache/${MP}/${plugin}`;
const marketplacePluginKey = (plugin: string): string => `${marketplaceKey}/plugins/${plugin}`;
const flatSkillKey = (skill: string): string => `home/.claude/skills/${skill}`;

/** Write what a previous `vat claude plugin install` of these plugins left: both trees and all three registry files. */
function writePriorPlugins(r: CaseRoot, plugins: readonly string[]): void {
  const marketplaces = safePath.join(pluginsDir(r), 'marketplaces', MP);
  // With VAT's marker, as installPlugin writes it: the uninstall removes only a marketplace VAT made.
  writeTree(marketplaces, [marketplaceJson(plugins), [VAT_MARKETPLACE_MARKER, 'vat\n'], ...plugins.flatMap((name) => prefixed(`plugins/${name}`, pluginFiles(name, PRIOR_VERSION)))]);
  for (const name of plugins) writeTree(safePath.join(pluginsDir(r), 'cache', MP, name, PRIOR_VERSION), pluginFiles(name, PRIOR_VERSION));
  const at = '2026-01-01T00:00:00.000Z';
  const installed = Object.fromEntries(plugins.map((name) => [`${name}@${MP}`, [{
    scope: 'user', installPath: safePath.join(pluginsDir(r), 'cache', MP, name, PRIOR_VERSION), version: PRIOR_VERSION, installedAt: at, lastUpdated: at,
  }]]));
  writeTree(pluginsDir(r), [
    ['known_marketplaces.json', JSON.stringify({ [MP]: { source: { source: 'npm', package: PACKAGE, version: PRIOR_VERSION }, installLocation: marketplaces, lastUpdated: at } }, null, 2)],
    ['installed_plugins.json', JSON.stringify({ version: 2, plugins: installed }, null, 2)],
  ]);
  writeTree(claudeDir(r), [['settings.json', JSON.stringify({ theme: 'dark', enabledPlugins: Object.fromEntries(plugins.map((name) => [`${name}@${MP}`, true])) }, null, 2)]]);
}

function writeFlatSkill(r: CaseRoot, name: string): void {
  writeTree(safePath.join(claudeDir(r), 'skills', name), [['SKILL.md', skillMd(name, PRIOR_VERSION)]]);
}

// --- I7: what the registry names after the run ------------------------------------------

function readJson(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    // Absent: a registry that is not there names nothing.
    if (isPathAbsentError(error)) return {};
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch (error) {
    // Half-written by a refused run: a registry no reader can parse names nothing.
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}

const present = (r: CaseRoot, key: string): boolean => existsSync(safePath.join(r.root, key));

/** The entries of `dir` that ARE `name` on this filesystem: one spelling, or on a case-folding one (`folds`) any spelling of it. */
function spellingsOf(dir: string, name: string, folds: boolean): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    // Absent: no spelling of it is there.
    if (isPathAbsentError(error)) return [];
    throw error;
  }
  return entries.filter((entry) => (folds ? entry.toLowerCase() === name.toLowerCase() : entry === name));
}

/**
 * The plugin units the registry names: a cache dir and a marketplace plugin dir per
 * installed key, the marketplace per known marketplace. A key names the directory as the
 * filesystem spells it (on a case-folding one, `FX-PLUGIN` IS `fx-plugin`), or its own
 * spelling when nothing is there. The registry files themselves and flat skills are outside
 * what any registry speaks for, so each counts as named exactly when it is there (they can
 * never disagree with it).
 */
function pluginRegistryNames(r: CaseRoot, flatSkills: readonly string[], folds = tmpdirFoldsCase()): string[] {
  const installed = (readJson(safePath.join(pluginsDir(r), 'installed_plugins.json'))['plugins'] ?? {}) as Record<string, unknown>;
  const known = readJson(safePath.join(pluginsDir(r), 'known_marketplaces.json'));
  const names: string[] = REGISTRY_KEYS.filter((key) => present(r, key));
  if (Object.hasOwn(known, MP)) names.push(marketplaceKey);
  const named = (dir: string, plugin: string, key: (name: string) => string): string[] => {
    const found = spellingsOf(dir, plugin, folds);
    return (found.length > 0 ? found : [plugin]).map(key);
  };
  for (const pluginKey of Object.keys(installed)) {
    if (!pluginKey.endsWith(`@${MP}`)) continue;
    const plugin = pluginKey.slice(0, -`@${MP}`.length);
    names.push(
      ...named(safePath.join(pluginsDir(r), 'cache', MP), plugin, cacheKey),
      ...named(safePath.join(pluginsDir(r), 'marketplaces', MP, 'plugins'), plugin, marketplacePluginKey),
    );
  }
  for (const skill of flatSkills) {
    if (present(r, `${flatSkillKey(skill)}/SKILL.md`)) names.push(flatSkillKey(skill));
  }
  return names;
}

// --- `vat claude plugin install` ----------------------------------------------------------

/** Where a lane's package lives: a directory for local / dev / postinstall, an archive for the rest. */
const packageDir = (r: CaseRoot): string => safePath.join(r.root, 'input', 'pkg');
const inputDir = (r: CaseRoot): string => safePath.join(r.root, 'input');
const tgzPath = (r: CaseRoot): string => safePath.join(inputDir(r), 'fx-pkg-1.0.0.tgz');

type PluginLane = 'local' | 'tgz' | 'npm' | 'npm-postinstall' | 'dev';
type PluginVariant = 'fresh' | 'force' | 'replaces' | 'case-aliased' | 'replaces-case-alias';

const VARIANT_SHAPES: Readonly<Record<PluginVariant, { prior: string[]; flatSkills: string[]; shape: PackageShape }>> = {
  fresh: { prior: [], flatSkills: [], shape: {} },
  force: { prior: [PLUGIN], flatSkills: [], shape: {} },
  replaces: { prior: [OLD_PLUGIN], flatSkills: [LEGACY_SKILL], shape: { replaces: { plugins: [OLD_PLUGIN], flatSkills: [LEGACY_SKILL] } } },
  'case-aliased': { prior: [ALIASED_PLUGIN], flatSkills: [], shape: { replaces: { plugins: [ALIASED_PLUGIN] } } },
  'replaces-case-alias': { prior: [ALIASED_PLUGIN], flatSkills: [], shape: { replaces: { plugins: [ALIASED_PLUGIN] } } },
};

/**
 * Review Focus 1 on every host: the `case-aliased` variant, with the alias SIMULATED. The two cache
 * spellings (`FX-PLUGIN`, `fx-plugin`) report one identity (`lstat`'s dev and ino); where the host keeps
 * case, `fx-plugin` is planted beside `FX-PLUGIN` so both names exist, as one directory has both on APFS.
 * GOLDEN: the new plugin installed into that one directory, and only `FX-PLUGIN@fx-mp` unregistered.
 */
const simulatedAlias = {
  fixture: (r: CaseRoot): void => {
    if (!tmpdirFoldsCase()) mkdirSyncReal(safePath.join(pluginsDir(r), 'cache', MP, PLUGIN), { recursive: true });
  },
  statRewrites: (r: CaseRoot): readonly StatRewrite[] => {
    const spellings = new Set([ALIASED_PLUGIN, PLUGIN].map((name) => safePath.join(pluginsDir(r), 'cache', MP, name)));
    return [{
      op: 'lstat',
      path: (path) => spellings.has(path),
      rewrite: (stats) => {
        const as = (value: bigint, like: number | bigint): number | bigint => (typeof like === 'bigint' ? value : Number(value));
        return Object.assign(Object.create(Object.getPrototypeOf(stats) as object) as typeof stats, stats, { dev: as(7n, stats.dev), ino: as(4242n, stats.ino) });
      },
    }];
  },
};

function writeLaneInput(lane: PluginLane, r: CaseRoot, files: readonly TreeFile[]): void {
  if (lane === 'tgz' || lane === 'npm') {
    mkdirSyncReal(inputDir(r), { recursive: true });
    writeFileSync(tgzPath(r), tarballOf(prefixed('package', files)));
    return;
  }
  writeTree(packageDir(r), files);
}

function laneArgv(lane: PluginLane, r: CaseRoot): string[] {
  switch (lane) {
    // No --force: a re-install must take its own marketplace on the marker's word (the default path),
    // which --force would bypass.
    case 'local': return ['install', packageDir(r)];
    case 'tgz': return ['install', tgzPath(r)];
    case 'npm': return ['install', `npm:${PACKAGE}`];
    case 'npm-postinstall': return ['install', '--npm-postinstall'];
    case 'dev': return ['install', '--dev', '--cwd', packageDir(r)];
  }
}

/**
 * The npm lane: `npm pack` is replaced by copying the fixture tarball into the download dir, then
 * extracted in-process as the real one is. The copy stands in for the CHILD process `npm pack`, so
 * a fault on it ends as the real seam's failure does (`EXTERNAL_API_FAILED`, `downloadNpmPackage`),
 * never as a raw errno the real code could not have seen.
 */
function npmMocks(r: CaseRoot): void {
  vi.mocked(downloadNpmPackage).mockImplementation((name, tempDir) => {
    const tarball = safePath.join(tempDir, 'fx-pkg-1.0.0.tgz');
    try {
      copyFileSync(tgzPath(r), tarball);
    } catch (error) {
      throw new CommandRefusalError('EXTERNAL_API_FAILED', `npm pack failed for package ${name}: ${String(error)}`, { cause: error });
    }
    extractTarballSync(tarball, tempDir);
    return safePath.join(tempDir, 'package');
  });
}

/** The postinstall lane only runs inside a global `npm install`, which these variables say it is. */
function postinstallMocks(): void {
  vi.stubEnv('npm_config_global', 'true');
  vi.stubEnv('npm_lifecycle_event', 'postinstall');
  vi.stubEnv('npm_command', 'install');
}

/** A plugin install over one lane and one variant. */
export function pluginInstallCase(lane: PluginLane, variant: PluginVariant): VerbCase {
  const { prior, flatSkills, shape } = VARIANT_SHAPES[variant];
  const plugins = [...new Set([PLUGIN, ...prior])];
  const base: VerbCase = {
    id: `plugin/install/${lane}/${variant}`,
    group: (): Command => createPluginCommand(),
    argv: (r) => laneArgv(lane, r),
    fixture: (r) => {
      writeLaneInput(lane, r, packageFiles(shape));
      if (prior.length > 0) writePriorPlugins(r, prior);
      for (const skill of flatSkills) writeFlatSkill(r, skill);
      if (variant === 'replaces-case-alias') simulatedAlias.fixture(r);
    },
    watched: (r) => [claudeDir(r)],
    units: () => [marketplaceKey, ...plugins.map(cacheKey), ...REGISTRY_KEYS, ...flatSkills.map(flatSkillKey)],
    sources: (r) => [inputDir(r)],
    // The simulated alias folds the cache's spellings into one directory on every host, as the registry reads it.
    registered: (r) => pluginRegistryNames(r, flatSkills, variant === 'replaces-case-alias' || tmpdirFoldsCase()),
    ...(variant === 'replaces-case-alias' ? { statRewrites: simulatedAlias.statRewrites } : {}),
    // The tgz and npm lanes extract an archive into staging, classified with `shapeFromSource`:
    // a layout fault the archive decided is the archive's.
    ...(lane === 'tgz' || lane === 'npm' ? { shapeFromSource: true } : {}),
  };
  if (lane === 'npm') return { ...base, mocks: npmMocks };
  if (lane === 'npm-postinstall') return { ...base, mocks: postinstallMocks, cwd: packageDir };
  return base;
}

/** The skill the flat-skill cases install, as a directory and as a ZIP of it. */
const SKILL_FILES: readonly TreeFile[] = [['SKILL.md', skillMd(SKILL, VERSION)], ['references/notes.md', 'notes\n']];
const skillDirInput = (r: CaseRoot): string => safePath.join(inputDir(r), SKILL);
const skillZipInput = (r: CaseRoot): string => safePath.join(inputDir(r), `${SKILL}.zip`);

function writeSkillInput(r: CaseRoot, lane: 'dir' | 'zip'): void {
  if (lane === 'dir') {
    writeTree(skillDirInput(r), SKILL_FILES);
    return;
  }
  mkdirSyncReal(inputDir(r), { recursive: true });
  writeZipFixture(inputDir(r), `${SKILL}.zip`, SKILL_FILES.map(([path, body]) => [path, Buffer.from(body)]));
}

/** A case whose one unit is the flat skill ~/.claude/skills/fx-skill, installed fresh or over a prior install of it. */
function flatSkillCase(id: string, group: () => Command, argv: (r: CaseRoot) => readonly string[], lane: 'dir' | 'zip', variant: 'fresh' | 'force'): VerbCase {
  return {
    id,
    group,
    argv,
    fixture: (r) => {
      writeSkillInput(r, lane);
      if (variant === 'force') writeFlatSkill(r, SKILL);
    },
    watched: (r) => [claudeDir(r)],
    units: () => [flatSkillKey(SKILL)],
    sources: (r) => [inputDir(r)],
    // The zip lane extracts into staging, classified with `shapeFromSource`: a layout fault the archive decided is the archive's.
    ...(lane === 'zip' ? { shapeFromSource: true } : {}),
  };
}

/** `vat claude plugin install <skill.zip>`: a flat skill, not a plugin tree. */
function pluginInstallZipCase(variant: 'fresh' | 'force'): VerbCase {
  return flatSkillCase(`plugin/install/zip/${variant}`, () => createPluginCommand(), (r) => ['install', skillZipInput(r), '--force'], 'zip', variant);
}

// --- `vat claude plugin uninstall` --------------------------------------------------------

/** Uninstall `fx-plugin@fx-mp` by key, or every plugin of the package in the working directory (`--all`), beside a second plugin it must keep. */
function pluginUninstallCase(variant: 'key' | 'all'): VerbCase {
  const plugins = [PLUGIN, OLD_PLUGIN];
  const removed = variant === 'all' ? plugins : [PLUGIN];
  return {
    id: `plugin/uninstall/${variant}`,
    group: (): Command => createPluginCommand(),
    argv: () => (variant === 'all' ? ['uninstall', '--all'] : ['uninstall', `${PLUGIN}@${MP}`]),
    fixture: (r) => {
      writePriorPlugins(r, plugins);
      writeTree(packageDir(r), [['package.json', JSON.stringify({ name: PACKAGE, version: VERSION })]]);
    },
    watched: (r) => [claudeDir(r)],
    // The marketplace is a unit too: known_marketplaces.json names it exactly while it is there (I7),
    // and `--all` takes it with its last plugin.
    units: () => [marketplaceKey, ...removed.flatMap((plugin) => [marketplacePluginKey(plugin), cacheKey(plugin)]), ...REGISTRY_KEYS],
    sources: (r) => [inputDir(r)],
    registered: (r) => pluginRegistryNames(r, []),
    cwd: packageDir,
  };
}

// --- `vat skills install` -----------------------------------------------------------------

/** `vat skills install <dir|zip> --target claude --scope user`, fresh or over a prior install. */
export function skillsInstallCase(lane: 'dir' | 'zip', variant: 'fresh' | 'force'): VerbCase {
  const argv = (r: CaseRoot): string[] => [
    'install', lane === 'dir' ? skillDirInput(r) : skillZipInput(r), '--target', 'claude', '--scope', 'user', ...(variant === 'force' ? ['--force'] : []),
  ];
  return flatSkillCase(`skills/install/${lane}/${variant}`, () => createSkillsCommand(), argv, lane, variant);
}

// --- `vat agent install` / `vat agent uninstall` ------------------------------------------

/** An agent package: its manifest where discovery finds it, and its built bundle. */
function writeAgentPackage(r: CaseRoot): void {
  writeTree(packageDir(r), [
    ['package.json', JSON.stringify({ name: '@fx/fx-agents', version: VERSION })],
    [`agents/${AGENT}/agent.yaml`, `metadata:\n  name: ${AGENT}\n  version: ${VERSION}\nspec:\n  llm:\n    provider: anthropic\n    model: claude-sonnet-5\n`],
    [`dist/vat-bundles/skill/${AGENT}/SKILL.md`, skillMd(AGENT, VERSION)],
    [`dist/vat-bundles/skill/${AGENT}/references/notes.md`, 'notes\n'],
  ]);
}

const builtBundle = (r: CaseRoot): string => safePath.join(packageDir(r), 'dist', 'vat-bundles', 'skill', AGENT);

/** A previous install: a copy, or (`dev`) a link to the built bundle. */
function writePriorAgent(r: CaseRoot, dev: boolean): void {
  const installPath = safePath.join(claudeDir(r), 'skills', AGENT);
  if (!dev) {
    writeTree(installPath, [['SKILL.md', skillMd(AGENT, PRIOR_VERSION)]]);
    return;
  }
  const capability = symlinkCapability();
  if (capability === null) throw new Error('the --dev agent cases need symlinks; gate them on a host that can make them');
  mkdirSyncReal(safePath.join(installPath, '..'), { recursive: true });
  createSymlink(capability, builtBundle(r), installPath, 'dir');
}

/** A `vat agent` case: the agent package is the working directory, its install under ~/.claude/skills the one unit. */
function agentCase(id: string, argv: readonly string[], prior: (r: CaseRoot) => void): VerbCase {
  return {
    id,
    group: (): Command => createAgentCommand(),
    argv: () => argv,
    fixture: (r) => {
      writeAgentPackage(r);
      prior(r);
    },
    watched: (r) => [claudeDir(r)],
    units: () => [flatSkillKey(AGENT)],
    sources: (r) => [inputDir(r)],
    cwd: packageDir,
  };
}

/** `vat agent install fx-agent` (copy or `--dev`), fresh or `--force` over a prior copy. */
function agentInstallCase(mode: 'copy' | 'dev', variant: 'fresh' | 'force'): VerbCase {
  const argv = ['install', AGENT, ...(mode === 'dev' ? ['--dev'] : []), ...(variant === 'force' ? ['--force'] : [])];
  return agentCase(`agent/install/${mode}/${variant}`, argv, (r) => {
    if (variant === 'force') writePriorAgent(r, false);
  });
}

/** `vat agent uninstall fx-agent` of a copied install, or of a `--dev` link. */
function agentUninstallCase(mode: 'copy' | 'dev'): VerbCase {
  return agentCase(`agent/uninstall/${mode}`, ['uninstall', AGENT], (r) => writePriorAgent(r, mode === 'dev'));
}

// --- the shard table -----------------------------------------------------------------------

/**
 * Every install-family case, and how many matrix files share its injections: each file holds
 * one case's slice (the injections whose id hashes to it: `shardOf(id, files) === index`), which must fit the shard limit (C10).
 *
 * A case's count is at least `shardFilesFor` of the MOST injections it selects on any host (the
 * overflow refusal prints that total and the count to use — one more than it has, when it already
 * has that many and one slice overflowed by the hash's scatter). The trace is the host's: the `case-aliased`
 * variants install over a real alias only where the filesystem folds case — where it keeps case the
 * two spellings are two directories, the replaced one is really removed, and the case selects about
 * a fifth more; a Node that traces inside `rm` selects more than one that does not.
 * `fault-matrix-shards.integration.test.ts` holds each file to this table.
 */
export const INSTALL_FAMILY_SHARDS = {
  'plugin/install/local/fresh': { make: () => pluginInstallCase('local', 'fresh'), files: 14 },
  'plugin/install/local/force': { make: () => pluginInstallCase('local', 'force'), files: 16 },
  'plugin/install/local/replaces': { make: () => pluginInstallCase('local', 'replaces'), files: 22 },
  'plugin/install/local/case-aliased': { make: () => pluginInstallCase('local', 'case-aliased'), files: 19 },
  'plugin/install/local/replaces-case-alias': { make: () => pluginInstallCase('local', 'replaces-case-alias'), files: 17 },
  'plugin/install/tgz/fresh': { make: () => pluginInstallCase('tgz', 'fresh'), files: 23 },
  'plugin/install/npm/fresh': { make: () => pluginInstallCase('npm', 'fresh'), files: 23 },
  'plugin/install/npm-postinstall/fresh': { make: () => pluginInstallCase('npm-postinstall', 'fresh'), files: 14 },
  'plugin/install/dev/fresh': { make: () => pluginInstallCase('dev', 'fresh'), files: 12, posixOnly: true },
  'plugin/install/dev/force': { make: () => pluginInstallCase('dev', 'force'), files: 14, posixOnly: true },
  'plugin/install/dev/replaces': { make: () => pluginInstallCase('dev', 'replaces'), files: 20, posixOnly: true },
  'plugin/install/dev/case-aliased': { make: () => pluginInstallCase('dev', 'case-aliased'), files: 17, posixOnly: true },
  'plugin/install/zip/fresh': { make: () => pluginInstallZipCase('fresh'), files: 10 },
  'plugin/install/zip/force': { make: () => pluginInstallZipCase('force'), files: 10 },
  'plugin/uninstall/key': { make: () => pluginUninstallCase('key'), files: 8 },
  'plugin/uninstall/all': { make: () => pluginUninstallCase('all'), files: 18 },
  'skills/install/dir/fresh': { make: () => skillsInstallCase('dir', 'fresh'), files: 7 },
  'skills/install/dir/force': { make: () => skillsInstallCase('dir', 'force'), files: 7 },
  'skills/install/zip/fresh': { make: () => skillsInstallCase('zip', 'fresh'), files: 10 },
  'skills/install/zip/force': { make: () => skillsInstallCase('zip', 'force'), files: 10 },
  'agent/install/copy/fresh': { make: () => agentInstallCase('copy', 'fresh'), files: 8 },
  'agent/install/copy/force': { make: () => agentInstallCase('copy', 'force'), files: 8 },
  'agent/install/dev/fresh': { make: () => agentInstallCase('dev', 'fresh'), files: 3, posixOnly: true },
  'agent/install/dev/force': { make: () => agentInstallCase('dev', 'force'), files: 4, posixOnly: true },
  'agent/uninstall/copy': { make: () => agentUninstallCase('copy'), files: 2 },
  'agent/uninstall/dev': { make: () => agentUninstallCase('dev'), files: 2, posixOnly: true },
} as const satisfies Readonly<Record<string, MatrixShard>>;
