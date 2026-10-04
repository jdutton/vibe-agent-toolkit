/**
 * The exit-code matrix's ONE scenario table, its unreachable-status table, the
 * fixtures both are built from, and the shard definition that runs them.
 *
 * ## Why this is a module and not a spec file
 *
 * The matrix spawns the built CLI once per scenario, and it grew with every verb
 * that became a report: as one spec file it ran 83 s against the system tier's
 * 30 s per-file budget. The spawning is now spread over several spec files —
 * `exit-code-matrix-shard-<name>.system.test.ts`, one per key of
 * {@link MATRIX_SHARDS} — and every one of them reads the SAME table from here.
 * Nothing is copied into a shard: a shard file is one call to
 * {@link exitCodeMatrixShard}, which takes its slice by the file's own name.
 *
 * ## What keeps the split honest
 *
 * `exit-code-matrix.system.test.ts` asserts, over the WHOLE table: the table and
 * the registry agree both ways; every verb shows or explains every status; the
 * shards partition the table (every verb in exactly one); and the shard spec
 * files on disk are exactly the declared shards. A shard file can run only the
 * shard it is named after, so "declared" and "executed" cannot drift apart.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  exitCodeForReport,
  type ExitDeterminingDocument,
  type RefusalCode,
  type ReportStatus,
} from '@vibe-agent-toolkit/schema';
import { createSymlink, mkdirSyncReal, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { buildWindowsShellLine, shouldUseShell } from '@vibe-agent-toolkit/utils/process';
import { CANNOT_DENY_READS, findExecutable, gitExecutable } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, expect, type TestContext } from 'vitest';
import yaml from 'yaml';

import { PUBLISHED_SHAPES } from '../../../src/report-schemas.js';
import { cleanupTestTempDir, createTestTempDir, fakeHomeEnv, getBinPath, writeFileTree } from '../test-common.js';

import { executeCli } from './cli-runner.js';

/** The built CLI every matrix file spawns — resolved from the system-test directory, where the spec files live. */
export const MATRIX_BIN_PATH = getBinPath(new URL('../exit-code-matrix.system.test.ts', import.meta.url).href);

/** A directory's mode bits when nothing may read or enter it, and when everything may. */
export const UNREADABLE = 0o000;
export const READABLE = 0o755;
/** A directory whose entries cannot be removed: listable, enterable, not writable. */
const UNWRITABLE = 0o555;

/**
 * The temp dir of the spec file that imported this module. Vitest evaluates this
 * module once per spec file, so each matrix file has its own — set by
 * {@link useMatrixTempDir} and read by every fixture builder below.
 */
let tempDir: string;

/** The running spec file's temp dir — valid inside a test of a suite that called {@link useMatrixTempDir}. */
export function matrixTempDir(): string {
  return tempDir;
}

/**
 * Give the enclosing suite its temp dir: created before its tests, and removed
 * after them once every path a scenario locked is unlocked again.
 */
export function useMatrixTempDir(): void {
  beforeAll(() => {
    tempDir = createTestTempDir('vat-exit-matrix-');
  });

  afterAll(() => {
    for (const locked of lockedByScenarios.splice(0)) chmodSync(locked, READABLE);
    cleanupTestTempDir(tempDir);
  });
}

/** Alphabetical, spelled out so the sort does not depend on the default comparator. */
export const byName = (a: string, b: string): number => a.localeCompare(b);

/** A git project under the suite's temp dir, with a config and the given files. */
export function project(name: string, config: string, files: Readonly<Record<string, string>> = {}): string {
  const dir = safePath.join(tempDir, name);
  mkdirSyncReal(dir, { recursive: true });
  writeFileTree(dir, { 'vibe-agent-toolkit.config.yaml': config, ...files });
  spawnSync(gitExecutable(), ['init', '--quiet'], { cwd: dir });
  spawnSync(gitExecutable(), ['add', '.'], { cwd: dir });
  return dir;
}

/** A SKILL.md nothing complains about at error or warning severity. */
const CLEAN_SKILL = '---\nname: clean\ndescription: Reviews widgets for quality. Use when a reviewer wants a '
  + 'checklist walkthrough of a widget in depth.\n---\n\n# clean\n\nPurpose statement goes here.\n\nDoes one thing well.\n';
/** A SKILL.md with an error-severity finding: a description past the 1024-character limit. */
const BROKEN_SKILL = `---\nname: broken\ndescription: Reviews widgets. ${'Use when a reviewer wants a walkthrough. '.repeat(30)}\n---\n\n# broken\n\nBody.\n`;

const OKF_CONFIG = 'okf:\n  bundles:\n    knowledge:\n      root: ./bundles/knowledge\n';
/**
 * One declared skill, so the manifest advertises something: an `ard:` block
 * over no surface examines nothing, and the writer refuses that run.
 */
const ARD_CONFIG = 'skills:\n  include: ["skills/**/SKILL.md"]\n  config:\n    clean: {}\n'
  + 'ard:\n  publisher: example.com\n  baseUrl: https://example.com/catalog\n';
const CHECK_CONFIG = (sql: string): string =>
  `resources:\n  checks:\n    probe:\n      description: probe\n      sql: "${sql}"\n`;
/** A tree whose markdown git ignores wholesale: the population enumerates nothing. */
const NOTHING_TRACKED = { '.gitignore': '*\n', 'docs/a.md': '# A\n' } as const;
/** A project whose `skills:` block discovers every `skills/<name>/SKILL.md`. */
const SKILLS_CONFIG = 'skills:\n  include: ["skills/*/SKILL.md"]\n';
/** A one-eval suite for `clean`, so `skill test run --dry-run` has something to stage. */
const CLEAN_EVALS = JSON.stringify({ skill_name: 'clean', evals: [{ id: 'one', prompt: 'Review this widget.', expectations: ['It reviews the widget.'] }] });
/**
 * Whether a `claude` binary answers on PATH. A dry run spends no tokens, but the
 * harness preflight still probes the binary (version, `--help` flags, `auth status`)
 * before it stages anything, so without one every run refuses BACKEND_UNAVAILABLE.
 */
function hasClaude(): boolean {
  return probeExitsZero('claude', ['--version']);
}

/**
 * Whether the tool `name` is on PATH and exits 0 for `args`. One spawn
 * convention for every machine probe: the resolved absolute path, and on
 * Windows a `.cmd` shim (how npm installs both `npm` and `claude`) through the
 * one shell line `buildWindowsShellLine` builds — never an args array beside
 * `shell: true`.
 */
function probeExitsZero(name: string, args: string[], timeout?: number): boolean {
  const executable = findExecutable(name);
  if (executable === undefined) return false;
  const options = { stdio: 'ignore' as const, ...(timeout === undefined ? {} : { timeout }) };
  const result = shouldUseShell(executable)
    ? spawnSync(buildWindowsShellLine(`"${executable}"`, args), { ...options, shell: true })
    : spawnSync(executable, args, options);
  return result.status === 0;
}
/** A marketplace declaring one local plugin, with every file the strict validation asks for. */
const MARKETPLACE_FILES: Readonly<Record<string, string>> = {
  '.claude-plugin/marketplace.json': JSON.stringify({
    name: 'matrix-mp',
    description: 'Matrix marketplace',
    version: '1.0.0',
    owner: { name: 'Matrix' },
    plugins: [{ name: 'p', source: './plugins/p' }],
  }),
  'plugins/p/.claude-plugin/plugin.json': JSON.stringify({ name: 'p', description: 'A plugin', version: '1.0.0', author: { name: 'Matrix' }, license: 'MIT' }),
  LICENSE: 'MIT\n',
  'README.md': '# Matrix\n',
  'CHANGELOG.md': '# Changelog\n',
};
/** An agent manifest the schema accepts, referencing nothing that must exist. */
const AGENT_MANIFEST = 'metadata:\n  name: matrix-agent\n  version: 0.1.0\n  description: Matrix agent\n'
  + 'spec:\n  llm:\n    provider: anthropic\n    model: claude-sonnet-5\n';

/** An agent `vat agent build` can build: a manifest naming a system prompt that is there, inside a package for the default output. */
const BUILDABLE_AGENT_FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: 'matrix-agents' }),
  'agent/agent.yaml': `${AGENT_MANIFEST}  prompts:\n    system:\n      $ref: ./prompts/system.md\n`,
  'agent/prompts/system.md': 'You review widgets.\n',
};
/** An agent `vat agent install matrix-agent` can install: discoverable under `agents/`, its bundle already built. */
const INSTALLABLE_AGENT_FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: 'matrix-agents' }),
  'agents/matrix-agent/agent.yaml': AGENT_MANIFEST,
  'dist/vat-bundles/skill/matrix-agent/SKILL.md': '---\nname: matrix-agent\ndescription: Matrix agent\n---\n',
};
/** A SKILL.md whose frontmatter is not YAML: it cannot be read as a skill. */
const UNIMPORTABLE_SKILL = '---\nname: [unclosed\n---\n\n# unimportable\n';

/** A plugin tree `vat build` would leave, declaring one skill whose `dist/skills/` build is missing. */
const UNBUILT_PLUGIN_FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: '@matrix/plugin-pkg', version: '1.0.0' }),
  'dist/.claude/plugins/marketplaces/matrix-mp/plugins/p/.claude-plugin/plugin.json': JSON.stringify({ name: 'p' }),
  'dist/.claude/plugins/marketplaces/matrix-mp/plugins/p/skills/unbuilt/SKILL.md': '# unbuilt\n',
};

/** A plugin directory under `home`'s Claude marketplaces with no registry entry — a half-removed install. */
function orphanPluginIn(home: string): void {
  mkdirSyncReal(safePath.join(home, '.claude', 'plugins', 'marketplaces', 'matrix-mp', 'plugins', 'p'), { recursive: true });
}

/**
 * Directories a scenario made unlistable. A scenario cannot restore what it
 * locked (it only returns the invocation), so the suite restores every one
 * before removing its temp dir — a mode-0 directory is not removable.
 */
const lockedByScenarios: string[] = [];

/** A project holding one clean skill beside a directory the OS will not list. */
function projectWithLockedDir(name: string): string {
  const dir = project(name, '{}\n', { 'skills/clean/SKILL.md': CLEAN_SKILL });
  const locked = safePath.join(dir, 'skills', 'locked');
  mkdirSyncReal(locked, { recursive: true });
  chmodSync(locked, UNREADABLE);
  lockedByScenarios.push(locked);
  return dir;
}

/** `vat skills install`'s required placement flags, into the scenario's project. */
export const SKILLS_INSTALL_FLAGS = ['--target', 'claude', '--scope', 'project'] as const;

/** `--dev` symlinks, which the command refuses on Windows before doing anything. */
const DEV_INSTALL_SKIP = process.platform === 'win32' ? '--dev is refused on Windows' : undefined;

/** A marketplace of one local plugin holding a command; `pluginExtra` is YAML appended to the plugin entry. */
const PLUGIN_BUILD_CONFIG = (pluginExtra = ''): string =>
  'claude:\n  marketplaces:\n    matrix-mp:\n      owner:\n        name: Matrix\n'
  + `      plugins:\n        - name: p\n          skills: []\n${pluginExtra}`;
const PLUGIN_BUILD_FILES: Readonly<Record<string, string>> = { 'plugins/p/commands/hello.md': '# hello\n' };

/** A marketplace with a `publish:` block, or without one; the remote is never contacted under `--dry-run`. */
const PUBLISH_CONFIG = (publish: boolean): string =>
  'claude:\n  marketplaces:\n    matrix-mp:\n      owner:\n        name: Matrix\n'
  + (publish ? '      publish:\n        changelog: CHANGELOG.md\n        remote: https://example.invalid/matrix.git\n' : '')
  + '      plugins:\n        - name: p\n          skills: []\n';
/** What `vat build` leaves for `publish`, and a changelog with release notes. */
const PUBLISH_FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: 'matrix', version: '1.0.0' }),
  'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n\n- A change\n',
  'dist/.claude/plugins/marketplaces/matrix-mp/.claude-plugin/marketplace.json': JSON.stringify({
    name: 'matrix-mp',
    owner: { name: 'Matrix' },
    plugins: [{ name: 'p', source: './plugins/p', version: '1.0.0' }],
  }),
};

/** A `resources:` block holding one collection over `docs/`. */
const RESOURCES_CONFIG = 'resources:\n  collections:\n    guides:\n      include:\n        - "docs/*.md"\n';
/**
 * A `resources:` block whose one `linkAuth` provider does not compile, beside
 * the skills block: the resources phase refuses (CONFIG_INVALID) and the
 * skills phase still finishes.
 */
const BROKEN_RESOURCES_WITH_SKILLS = `${SKILLS_CONFIG}resources:\n  linkAuth:\n    providers:\n`
  + '      - match: { host: "matrix.example" }\n        rewrite:\n          - when: "([unclosed"\n            to: "https://api.example/x"\n'
  + '        auth: { headers: { Authorization: "Bearer ${token}" } }\n        token: [{ env: MATRIX_TOKEN }]\n'
  + '        check: { method: GET, aliveStatus: [200], notFoundMeaning: ambiguous }\n';
/** A marketplace whose one plugin has no directory, no files and no skills: the claude phase refuses it (CONFIG_INVALID). */
const EMPTY_PLUGIN_CONFIG = `${SKILLS_CONFIG}claude:\n  marketplaces:\n    matrix-mp:\n      owner:\n        name: Matrix\n`
  + '      plugins:\n        - name: p\n          skills: []\n';

/**
 * The temp root every scenario's child sees: the suite's own temp dir. Redirected
 * because `<tmpdir>/.vat-cache` is shared machine state — `vat cache clear`
 * deletes it, and nothing in the matrix may delete the developer's (or a sibling
 * test file's) cache. The suite's temp dir rather than one per scenario, because
 * the temp root is not only where caches live: verbs judge paths by it (a skill
 * inside the OS temp dir skips the name-vs-directory check), and every fixture
 * project here lives under this directory, as it did under the real one. All
 * three variables, because each platform reads a different one.
 */
function scenarioEnv(home: string): Record<string, string> {
  return { ...fakeHomeEnv(home), TMPDIR: tempDir, TEMP: tempDir, TMP: tempDir };
}

/** The `.vat-cache` a scenario's child clears — seeded by the `cache clear` scenarios. */
function scenarioCacheDir(): string {
  return safePath.join(tempDir, '.vat-cache');
}

/**
 * Whether the npm registry answers `npm view`. `vat doctor`'s version check
 * asks it, and an unanswered one is `undetermined` — a warning, so the `ok`
 * scenario needs a registry to reach.
 */
function npmReachable(): boolean {
  return probeExitsZero('npm', ['view', 'vibe-agent-toolkit', 'version'], 30_000);
}

/**
 * The ONNX model the RAG lane embeds with, where the embedding provider caches
 * it: under the REAL home, read before any scenario swaps HOME. A scenario that
 * embeds links it into its fake HOME; without it the provider would download
 * the model, which this suite never does — so such a scenario is skipped.
 */
const ONNX_MODEL_CACHE = safePath.join(homedir(), '.cache', 'vat-onnx-models');
const ONNX_MODEL_CACHED = ['model_quantized.onnx', 'vocab.txt'].every((file) => existsSync(safePath.join(ONNX_MODEL_CACHE, 'Xenova_all-MiniLM-L6-v2', file)));
const SYMLINKS = symlinkCapability();
function noOnnxModelReason(): string | undefined {
  if (!ONNX_MODEL_CACHED) return 'no ONNX model is cached under ~/.cache/vat-onnx-models, and this suite never downloads one';
  return SYMLINKS === null ? 'this host cannot link the model cache into a fake HOME' : undefined;
}

/** Point `home`'s model cache at the real one (a junction, so Windows needs no privilege). */
function linkOnnxModelCache(home: string): void {
  if (SYMLINKS === null) throw new Error('linkOnnxModelCache needs symlinks; the scenario should have been skipped');
  mkdirSyncReal(safePath.join(home, '.cache'), { recursive: true });
  createSymlink(SYMLINKS, ONNX_MODEL_CACHE, safePath.join(home, '.cache', 'vat-onnx-models'), 'junction');
}

/** A RAG database path of the scenario's own, not yet created. */
export function ragDb(name: string): string {
  return safePath.join(tempDir, 'rag-dbs', name);
}

/**
 * `vat corpus scan` over a one-entry seed naming `source` under a fresh
 * directory holding `files`, into `--out` beside it. The verb publishes YAML;
 * it takes no `--format`.
 */
function corpusScan(name: string, files: Readonly<Record<string, string>>, source: string): ScenarioRun {
  const dir = safePath.join(tempDir, name);
  mkdirSyncReal(dir, { recursive: true });
  const seed = { plugins: [{ source: safePath.join(dir, source), name: 'entry', bucket: 'official', confidence: 'first-party', maturity: 'production' }] };
  writeFileTree(dir, { ...files, 'seed.yaml': yaml.stringify(seed) });
  return { args: ['corpus', 'scan', safePath.join(dir, 'seed.yaml'), '--out', safePath.join(dir, 'out')], cwd: dir };
}

/** A directory under no project: a RAG verb run here without `--db` has no database to name. */
function noProject(name: string): string {
  const dir = safePath.join(tempDir, name);
  mkdirSyncReal(dir, { recursive: true });
  return dir;
}

/** A plugin directory `vat inventory` can inventory: a manifest and nothing else, outside any project. */
function inventoryPlugin(name: string): string {
  const dir = noProject(name);
  writeFileTree(dir, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'p' }) });
  return dir;
}

/** What a scenario hands the runner: the arguments to spawn the CLI with, and where. */
interface ScenarioRun {
  args: string[];
  cwd: string;
}

/** One run of one envelope verb, and the status its document must carry. */
interface ScenarioBase {
  /**
   * The verb's arguments and working directory, built inside the suite's temp
   * dir. `home` is this scenario's own fresh fake HOME — every scenario runs
   * under one, so no verb in the matrix can read or mutate the developer's real
   * `~/.claude`; a scenario that needs installed state seeds it there. A
   * scenario that needs cache state seeds it under {@link scenarioCacheDir}.
   */
  readonly run: (home: string) => ScenarioRun;
  /**
   * Why this scenario cannot run on this platform — it still counts as present.
   * Asked only by the shard that runs the scenario, when it declares the test:
   * two of the reasons probe the machine (a `claude` binary, the npm registry),
   * and every matrix file imports this table.
   */
  readonly skipReason?: () => string | undefined;
}

/** An `error` scenario names its refusal code; a completed one has none to name. */
type Scenario =
  | (ScenarioBase & { readonly status: Exclude<ReportStatus, 'error'> })
  | (ScenarioBase & { readonly status: 'error'; readonly code: RefusalCode });

/**
 * The not-implemented `claude org` leaves, each with the options Commander
 * requires. A stub only ever refuses: it has no run that could be `ok` or
 * `findings`, so its one scenario is the error branch and the other two
 * statuses are declared unreachable below.
 */
const ORG_STUB_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  'claude org api-keys update': ['key_1', '--name', 'n'],
  'claude org invites create': ['--email', 'a@example.com', '--role', 'user'],
  'claude org invites delete': ['inv_1'],
  'claude org users update': ['user_1', '--role', 'admin'],
  'claude org users remove': ['user_1'],
  'claude org workspaces create': ['--name', 'w'],
  'claude org workspaces archive': ['ws_1'],
  'claude org workspaces members add': ['ws_1', '--user-id', 'u', '--role', 'workspace_user'],
  'claude org workspaces members update': ['ws_1', '--user-id', 'u', '--role', 'workspace_developer'],
  'claude org workspaces members remove': ['ws_1', '--user-id', 'u'],
};

const ORG_STUB_SCENARIOS: Readonly<Record<string, readonly Scenario[]>> = Object.fromEntries(
  Object.entries(ORG_STUB_OPTIONS).map(([verb, options]) => [
    verb,
    [{ status: 'error', code: 'NOT_IMPLEMENTED', run: () => ({ args: [...verb.split(' '), ...options], cwd: tempDir }) }],
  ]),
);

const ORG_STUB_UNREACHABLE: Readonly<Record<string, Partial<Record<ReportStatus, string>>>> = Object.fromEntries(
  Object.keys(ORG_STUB_OPTIONS).map((verb) => [
    verb,
    {
      ok: 'A not-implemented stub does no work: every run refuses with NOT_IMPLEMENTED.',
      findings: 'A not-implemented stub examines nothing, so it has nothing to report a finding about.',
    },
  ]),
);

/**
 * The envelope verbs, keyed exactly as `PUBLISHED_SHAPES` names them. Every
 * scenario asks for a machine document (`--format json` or `--yaml`) so the
 * code can be compared with what was published.
 */
export const ENVELOPE_SCENARIOS: Readonly<Record<string, readonly Scenario[]>> = {
  ...ORG_STUB_SCENARIOS,
  'resources check': [
    {
      status: 'ok',
      run: () => ({
        args: ['resources', 'check', '--budget', '0', '--format', 'json'],
        cwd: project('check-ok', CHECK_CONFIG("SELECT path FROM resource_realizations WHERE ext = '.txt'"), { 'docs/a.md': '# A\n' }),
      }),
    },
    {
      status: 'findings',
      run: () => ({
        args: ['resources', 'check', '--budget', '0', '--format', 'json'],
        cwd: project('check-findings', CHECK_CONFIG("SELECT path FROM resource_realizations WHERE ext = '.md'"), { 'docs/a.md': '# A\n' }),
      }),
    },
    {
      // Killed before the population: nothing examined, so the command could
      // not do its job — the ending that used to be 1 or 2 by timing.
      status: 'error',
      code: 'RUN_INCOMPLETE',
      run: () => ({
        args: ['resources', 'check', '--budget', '0.001', '--format', 'json'],
        cwd: project('check-error', CHECK_CONFIG("SELECT path FROM resource_realizations WHERE ext = '.md'"), { 'docs/a.md': '# A\n' }),
      }),
    },
  ],
  inventory: [
    { status: 'ok', run: () => ({ args: ['inventory', inventoryPlugin('inventory-ok'), '--format', 'json'], cwd: tempDir }) },
    // A skills directory the OS will not list was not inventoried: a SCAN_PATH_UNREADABLE warning (exit 0).
    {
      status: 'findings',
      skipReason: () => (CANNOT_DENY_READS ? 'this platform cannot deny a directory listing' : undefined),
      run: (): ScenarioRun => {
        const dir = inventoryPlugin('inventory-findings');
        const locked = safePath.join(dir, 'skills', 'locked');
        mkdirSyncReal(locked, { recursive: true });
        chmodSync(locked, UNREADABLE);
        lockedByScenarios.push(locked);
        return { args: ['inventory', dir, '--format', 'json'], cwd: tempDir };
      },
    },
    // No path and neither --user nor --system: nothing was named to inventory.
    { status: 'error', code: 'USAGE_INVALID', run: () => ({ args: ['inventory', '--format', 'json'], cwd: tempDir }) },
  ],
  audit: [
    { status: 'ok', run: () => ({ args: ['audit', '.'], cwd: project('audit-ok', '{}\n', { 'skills/clean/SKILL.md': CLEAN_SKILL }) }) },
    // An error-severity finding is `findings` at exit 1 — `error` is reserved for a run that did not finish.
    { status: 'findings', run: () => ({ args: ['audit', '.'], cwd: project('audit-findings', '{}\n', { 'skills/broken/SKILL.md': BROKEN_SKILL }) }) },
    { status: 'error', code: 'USAGE_INVALID', run: () => ({ args: ['audit', 'never-created'], cwd: project('audit-error', '{}\n') }) },
  ],
  'audit settings': [
    {
      status: 'ok',
      run: () => ({ args: ['audit', 'settings', '--file', 'settings.json', '--type', 'project'], cwd: project('settings-ok', '{}\n', { 'settings.json': '{}\n' }) }),
    },
    {
      status: 'findings',
      run: () => ({
        args: ['audit', 'settings', '--file', 'settings.json', '--type', 'project'],
        cwd: project('settings-findings', '{}\n', { 'settings.json': '{"permissions": 5}\n' }),
      }),
    },
    // A `--type` the command does not know is the invocation's mistake.
    {
      status: 'error',
      code: 'USAGE_INVALID',
      run: () => ({ args: ['audit', 'settings', '--file', 'settings.json', '--type', 'bogus'], cwd: project('settings-error', '{}\n', { 'settings.json': '{}\n' }) }),
    },
  ],
  'skill review': [
    { status: 'ok', run: () => ({ args: ['skill', 'review', 'SKILL.md', '--yaml'], cwd: project('review-ok', '{}\n', { 'SKILL.md': CLEAN_SKILL }) }) },
    { status: 'findings', run: () => ({ args: ['skill', 'review', 'SKILL.md', '--yaml'], cwd: project('review-findings', '{}\n', { 'SKILL.md': BROKEN_SKILL }) }) },
    // A path argument that names nothing is the invocation's mistake — never INTERNAL_ERROR.
    { status: 'error', code: 'USAGE_INVALID', run: () => ({ args: ['skill', 'review', 'never-created', '--yaml'], cwd: project('review-error', '{}\n') }) },
  ],
  'okf validate': [
    {
      status: 'ok',
      run: () => ({
        args: ['okf', 'validate', '--format', 'json'],
        cwd: project('okf-ok', OKF_CONFIG, { 'bundles/knowledge/concepts/a.md': '---\ntype: concept\ntitle: A\n---\n# A\n' }),
      }),
    },
    {
      status: 'findings',
      run: () => ({
        args: ['okf', 'validate', '--format', 'json'],
        cwd: project('okf-findings', OKF_CONFIG, { 'bundles/knowledge/concepts/a.md': '# A\n' }),
      }),
    },
    // A bundle argument the project does not declare is the invocation's mistake.
    { status: 'error', code: 'USAGE_INVALID', run: () => ({ args: ['okf', 'validate', 'no-such-bundle', '--format', 'json'], cwd: project('okf-error', OKF_CONFIG) }) },
  ],
  'resources validate': [
    { status: 'ok', run: () => ({ args: ['resources', 'validate', '--format', 'json'], cwd: project('validate-ok', '{}\n', { 'docs/a.md': '# A\n' }) }) },
    {
      status: 'findings',
      run: () => ({ args: ['resources', 'validate', '--format', 'json'], cwd: project('validate-findings', '{}\n', { 'docs/a.md': '# A\n\n[gone](./missing.md)\n' }) }),
    },
    // `--frontmatter-schema` naming no file is the invocation's mistake.
    {
      status: 'error',
      code: 'USAGE_INVALID',
      run: () => ({
        args: ['resources', 'validate', '--frontmatter-schema', 'never-created.json', '--format', 'json'],
        cwd: project('validate-error', '{}\n', { 'docs/a.md': '# A\n' }),
      }),
    },
  ],
  'resources scan': [
    { status: 'ok', run: () => ({ args: ['resources', 'scan', '--format', 'json'], cwd: project('scan-ok', '{}\n', { 'docs/a.md': '# A\n' }) }) },
    // Nothing scanned: the writer's run-integrity refusal is the finding.
    { status: 'findings', run: () => ({ args: ['resources', 'scan', 'docs', '--format', 'json'], cwd: project('scan-findings', '{}\n', { 'docs/notes.txt': 'not markdown\n' }) }) },
    { status: 'error', code: 'USAGE_INVALID', run: () => ({ args: ['resources', 'scan', 'never-created', '--format', 'json'], cwd: project('scan-error', '{}\n') }) },
  ],
  'resources query': [
    // Zero rows over a populated tree is an answer, not a finding.
    {
      status: 'ok',
      run: () => ({
        args: ['resources', 'query', "SELECT path FROM resource_realizations WHERE ext = '.txt'", '--format', 'json'],
        cwd: project('query-ok', '{}\n', { 'docs/a.md': '# A\n' }),
      }),
    },
    // A population of nothing answers nothing: the writer's run-integrity refusal.
    {
      status: 'findings',
      run: () => ({ args: ['resources', 'query', 'SELECT 1 AS one', '--format', 'json'], cwd: project('query-findings', '{}\n', NOTHING_TRACKED) }),
    },
    // A statement naming a column the projection lacks is the invocation's mistake.
    {
      status: 'error',
      code: 'USAGE_INVALID',
      run: () => ({
        args: ['resources', 'query', 'SELECT no_such_column FROM resource_realizations', '--format', 'json'],
        cwd: project('query-error', '{}\n', { 'docs/a.md': '# A\n' }),
      }),
    },
  ],
  'skills validate': [
    { status: 'ok', run: () => ({ args: ['skills', 'validate'], cwd: project('skills-ok', SKILLS_CONFIG, { 'skills/clean/SKILL.md': CLEAN_SKILL }) }) },
    { status: 'findings', run: () => ({ args: ['skills', 'validate'], cwd: project('skills-findings', SKILLS_CONFIG, { 'skills/broken/SKILL.md': BROKEN_SKILL }) }) },
    // A `[path]` that names no directory is the invocation's mistake.
    { status: 'error', code: 'USAGE_INVALID', run: () => ({ args: ['skills', 'validate', 'never-created'], cwd: project('skills-error', SKILLS_CONFIG) }) },
  ],
  'skills build': [
    { status: 'ok', run: () => ({ args: ['skills', 'build'], cwd: project('skills-build-ok', SKILLS_CONFIG, { 'skills/clean/SKILL.md': CLEAN_SKILL }) }) },
    // `--skill` naming a `publish: false` skill: examined, and not buildable.
    {
      status: 'findings',
      run: () => ({
        args: ['skills', 'build', '--skill', 'clean'],
        cwd: project('skills-build-findings', `${SKILLS_CONFIG}  config:\n    clean:\n      publish: false\n`, { 'skills/clean/SKILL.md': CLEAN_SKILL }),
      }),
    },
    { status: 'error', code: 'USAGE_INVALID', run: () => ({ args: ['skills', 'build', 'never-created'], cwd: project('skills-build-error', SKILLS_CONFIG) }) },
  ],
  'skills package': [
    {
      status: 'ok',
      run: () => ({ args: ['skills', 'package', 'skills/clean/SKILL.md', '-o', 'out/clean'], cwd: project('package-ok', SKILLS_CONFIG, { 'skills/clean/SKILL.md': CLEAN_SKILL }) }),
    },
    // The validation gate stops it: the skill's own error, nothing packaged.
    {
      status: 'findings',
      run: () => ({ args: ['skills', 'package', 'skills/broken/SKILL.md', '-o', 'out/broken'], cwd: project('package-findings', SKILLS_CONFIG, { 'skills/broken/SKILL.md': BROKEN_SKILL }) }),
    },
    {
      status: 'error',
      code: 'USAGE_INVALID',
      run: () => ({
        args: ['skills', 'package', 'skills/clean/SKILL.md', '-o', 'out/clean', '--target', 'nope'],
        cwd: project('package-error', SKILLS_CONFIG, { 'skills/clean/SKILL.md': CLEAN_SKILL }),
      }),
    },
  ],
  'skill test configure': [
    { status: 'ok', run: () => ({ args: ['skill', 'test', 'configure', 'clean', '--max-turns', '5'], cwd: project('configure-ok', SKILLS_CONFIG) }) },
    { status: 'error', code: 'USAGE_INVALID', run: () => ({ args: ['skill', 'test', 'configure', 'clean', '--max-turns', '0'], cwd: project('configure-error', SKILLS_CONFIG) }) },
  ],
  'skill test run': [
    // A dry run stages the suite and spawns nothing: `examined` is the one eval it staged.
    {
      status: 'ok',
      skipReason: () => (hasClaude() ? undefined : 'no claude binary on PATH: the harness preflight refuses before it stages'),
      run: (home) => ({
        args: ['skill', 'test', 'run', './skills/clean', '--dry-run', '--out', safePath.join(home, 'harness')],
        cwd: project('skill-test-run-ok', SKILLS_CONFIG, { 'skills/clean/SKILL.md': CLEAN_SKILL, 'skills/clean/evals/evals.json': CLEAN_EVALS }),
      }),
    },
    // An `--auth` value outside the set is refused before anything is staged or spawned.
    { status: 'error', code: 'USAGE_INVALID', run: () => ({ args: ['skill', 'test', 'run', 'clean', '--auth', 'bogus'], cwd: project('skill-test-run-error', SKILLS_CONFIG) }) },
  ],
  'claude marketplace validate': [
    { status: 'ok', run: () => ({ args: ['claude', 'marketplace', 'validate', '.'], cwd: project('marketplace-ok', '{}\n', MARKETPLACE_FILES) }) },
    // No LICENSE: an error-severity finding about the marketplace, exit 1.
    {
      status: 'findings',
      run: () => ({
        args: ['claude', 'marketplace', 'validate', '.'],
        cwd: project('marketplace-findings', '{}\n', Object.fromEntries(Object.entries(MARKETPLACE_FILES).filter(([file]) => file !== 'LICENSE'))),
      }),
    },
    { status: 'error', code: 'USAGE_INVALID', run: () => ({ args: ['claude', 'marketplace', 'validate', 'never-created'], cwd: project('marketplace-error', '{}\n') }) },
  ],
  'agent validate': [
    { status: 'ok', run: () => ({ args: ['agent', 'validate', './agent'], cwd: project('agent-ok', '{}\n', { 'agent/agent.yaml': AGENT_MANIFEST }) }) },
    // A manifest the schema rejects is a finding about the manifest, exit 1.
    {
      status: 'findings',
      run: () => ({ args: ['agent', 'validate', './agent'], cwd: project('agent-findings', '{}\n', { 'agent/agent.yaml': 'metadata:\n  name: x\nspec:\n  llm: 5\n' }) }),
    },
    { status: 'error', code: 'USAGE_INVALID', run: () => ({ args: ['agent', 'validate', './never-created'], cwd: project('agent-error', '{}\n') }) },
  ],
  'agent build': [
    { status: 'ok', run: () => ({ args: ['agent', 'build', './agent'], cwd: project('agent-build-ok', '{}\n', BUILDABLE_AGENT_FILES) }) },
    // A `--target` VAT does not build is the invocation's mistake, refused before anything is read.
    {
      status: 'error',
      code: 'USAGE_INVALID',
      run: () => ({ args: ['agent', 'build', './agent', '--target', 'nope'], cwd: project('agent-build-error', '{}\n', BUILDABLE_AGENT_FILES) }),
    },
  ],
  'agent import': [
    { status: 'ok', run: () => ({ args: ['agent', 'import', './skill/SKILL.md'], cwd: project('agent-import-ok', '{}\n', { 'skill/SKILL.md': CLEAN_SKILL }) }) },
    // A SKILL.md whose frontmatter no schema accepts cannot be read as a skill: the input's refusal.
    {
      status: 'error',
      code: 'INPUT_UNREADABLE',
      run: () => ({ args: ['agent', 'import', './skill/SKILL.md'], cwd: project('agent-import-error', '{}\n', { 'skill/SKILL.md': UNIMPORTABLE_SKILL }) }),
    },
  ],
  'agent installed': [
    // A fresh HOME has no skills directory: the scope is scanned, and empty is the answer.
    { status: 'ok', run: () => ({ args: ['agent', 'installed', '--scope', 'user'], cwd: tempDir }) },
    // A user skills directory the OS will not list: the listing is a floor, said as a warning finding (exit 0).
    {
      status: 'findings',
      skipReason: () => (CANNOT_DENY_READS ? 'this platform cannot deny a directory listing' : undefined),
      run: (home: string): ScenarioRun => {
        const skills = safePath.join(home, '.claude', 'skills');
        mkdirSyncReal(skills, { recursive: true });
        chmodSync(skills, UNREADABLE);
        lockedByScenarios.push(skills);
        return { args: ['agent', 'installed', '--scope', 'user'], cwd: tempDir };
      },
    },
    { status: 'error', code: 'USAGE_INVALID', run: () => ({ args: ['agent', 'installed', '--runtime', 'bogus'], cwd: tempDir }) },
  ],
  'agent list': [
    { status: 'ok', run: () => ({ args: ['agent', 'list'], cwd: project('agent-list-ok', '{}\n', { 'agents/matrix-agent/agent.yaml': AGENT_MANIFEST }) }) },
    // A search path the OS will not list: the listing is a floor, said as a warning finding (exit 0).
    {
      status: 'findings',
      skipReason: () => (CANNOT_DENY_READS ? 'this platform cannot deny a directory listing' : undefined),
      run: (): ScenarioRun => {
        const cwd = project('agent-list-findings', '{}\n', { 'agents/matrix-agent/agent.yaml': AGENT_MANIFEST });
        const agents = safePath.join(cwd, 'agents');
        chmodSync(agents, UNREADABLE);
        lockedByScenarios.push(agents);
        return { args: ['agent', 'list'], cwd };
      },
    },
  ],
  'agent install': [
    // Into this scenario's fake HOME: `~/.claude/skills/matrix-agent`.
    { status: 'ok', run: () => ({ args: ['agent', 'install', 'matrix-agent'], cwd: project('agent-install-ok', '{}\n', INSTALLABLE_AGENT_FILES) }) },
    { status: 'error', code: 'USAGE_INVALID', run: () => ({ args: ['agent', 'install', 'matrix-agent', '--scope', 'galaxy'], cwd: project('agent-install-error', '{}\n', INSTALLABLE_AGENT_FILES) }) },
  ],
  'agent uninstall': [
    {
      status: 'ok',
      run: (home: string): ScenarioRun => {
        writeFileTree(safePath.join(home, '.claude', 'skills', 'matrix-agent'), { 'SKILL.md': '# matrix-agent\n' });
        return { args: ['agent', 'uninstall', 'matrix-agent'], cwd: tempDir };
      },
    },
    // Nothing is installed under a fresh HOME: naming an agent that is not there is the invocation's mistake.
    { status: 'error', code: 'USAGE_INVALID', run: () => ({ args: ['agent', 'uninstall', 'matrix-agent'], cwd: tempDir }) },
  ],
  'skills list': [
    { status: 'ok', run: () => ({ args: ['skills', 'list', '.'], cwd: project('skills-list-ok', '{}\n', { 'skills/clean/SKILL.md': CLEAN_SKILL }) }) },
    // A directory the scan could not list: the listing is a floor, said as a warning finding (exit 0).
    {
      status: 'findings',
      skipReason: () => (CANNOT_DENY_READS ? 'this platform cannot deny a directory listing' : undefined),
      run: () => ({ args: ['skills', 'list', '.'], cwd: projectWithLockedDir('skills-list-findings') }),
    },
    { status: 'error', code: 'USAGE_INVALID', run: () => ({ args: ['skills', 'list', 'never-created'], cwd: project('skills-list-error', '{}\n') }) },
  ],
  'skills install': [
    {
      status: 'ok',
      run: () => ({ args: ['skills', 'install', './skill', ...SKILLS_INSTALL_FLAGS], cwd: project('skills-install-ok', '{}\n', { 'skill/SKILL.md': CLEAN_SKILL }) }),
    },
    // The skill fails its pre-install validation: its own error finding, nothing installed.
    {
      status: 'findings',
      run: () => ({ args: ['skills', 'install', './skill', ...SKILLS_INSTALL_FLAGS], cwd: project('skills-install-findings', '{}\n', { 'skill/SKILL.md': BROKEN_SKILL }) }),
    },
    {
      status: 'error',
      code: 'USAGE_INVALID',
      run: () => ({
        args: ['skills', 'install', './skill', '--target', 'nope', '--scope', 'project'],
        cwd: project('skills-install-error', '{}\n', { 'skill/SKILL.md': CLEAN_SKILL }),
      }),
    },
  ],
  'claude plugin list': [
    // A fresh HOME holds neither registry: both are consulted, and empty is the answer.
    { status: 'ok', run: () => ({ args: ['claude', 'plugin', 'list'], cwd: tempDir }) },
    { status: 'error', code: 'USAGE_INVALID', run: () => ({ args: ['claude', 'plugin', 'list', '--target', 'claude.ai'], cwd: tempDir }) },
  ],
  'claude plugin install': [
    { status: 'ok', run: () => ({ args: ['claude', 'plugin', 'install', './skill'], cwd: project('install-ok', '{}\n', { 'skill/SKILL.md': CLEAN_SKILL }) }) },
    // The plugin tree declares a skill whose build is missing: installed without it, and said so.
    {
      status: 'findings',
      skipReason: () => DEV_INSTALL_SKIP,
      run: () => ({ args: ['claude', 'plugin', 'install', '--dev'], cwd: project('install-findings', '{}\n', UNBUILT_PLUGIN_FILES) }),
    },
    { status: 'error', code: 'NOT_IMPLEMENTED', run: () => ({ args: ['claude', 'plugin', 'install', 'npm:@matrix/none', '--target', 'claude.ai'], cwd: tempDir }) },
  ],
  'claude plugin uninstall': [
    // Not installed: uninstall is idempotent, and nothing to remove is an answer.
    { status: 'ok', run: () => ({ args: ['claude', 'plugin', 'uninstall', 'p@matrix-mp'], cwd: tempDir }) },
    {
      status: 'findings',
      run: (home: string): ScenarioRun => {
        orphanPluginIn(home);
        return { args: ['claude', 'plugin', 'uninstall', 'p@matrix-mp'], cwd: tempDir };
      },
    },
    { status: 'error', code: 'USAGE_INVALID', run: () => ({ args: ['claude', 'plugin', 'uninstall'], cwd: tempDir }) },
  ],
  'claude plugin build': [
    { status: 'ok', run: () => ({ args: ['claude', 'plugin', 'build'], cwd: project('plugin-build-ok', PLUGIN_BUILD_CONFIG(), PLUGIN_BUILD_FILES) }) },
    // An `exclude:` pattern matching nothing is a warning: built, and said so.
    {
      status: 'findings',
      run: () => ({
        args: ['claude', 'plugin', 'build'],
        cwd: project('plugin-build-findings', PLUGIN_BUILD_CONFIG('          exclude: ["never/**"]\n'), PLUGIN_BUILD_FILES),
      }),
    },
    {
      status: 'error',
      code: 'USAGE_INVALID',
      run: () => ({ args: ['claude', 'plugin', 'build', '--marketplace', 'nope'], cwd: project('plugin-build-error', PLUGIN_BUILD_CONFIG(), PLUGIN_BUILD_FILES) }),
    },
  ],
  'claude marketplace publish': [
    {
      status: 'ok',
      run: () => ({ args: ['claude', 'marketplace', 'publish', '--dry-run'], cwd: project('publish-ok', PUBLISH_CONFIG(true), PUBLISH_FILES) }),
    },
    // No marketplace declares `publish:` — nothing was published, and the writer refuses the green.
    {
      status: 'findings',
      run: () => ({ args: ['claude', 'marketplace', 'publish', '--dry-run'], cwd: project('publish-findings', PUBLISH_CONFIG(false), PUBLISH_FILES) }),
    },
    {
      status: 'error',
      code: 'USAGE_INVALID',
      run: () => ({
        args: ['claude', 'marketplace', 'publish', '--dry-run', '--marketplace', 'nope'],
        cwd: project('publish-error', PUBLISH_CONFIG(true), PUBLISH_FILES),
      }),
    },
  ],
  // The orchestrators: one report over every phase. Each `error` is a PHASE that
  // did not finish after another one did — RUN_INCOMPLETE, exit 2, with the
  // finished phase still in `data.phases`.
  validate: [
    { status: 'ok', run: () => ({ args: ['validate'], cwd: project('orch-validate-ok', SKILLS_CONFIG, { 'skills/clean/SKILL.md': CLEAN_SKILL }) }) },
    { status: 'findings', run: () => ({ args: ['validate'], cwd: project('orch-validate-findings', SKILLS_CONFIG, { 'skills/broken/SKILL.md': BROKEN_SKILL }) }) },
    {
      status: 'error',
      code: 'RUN_INCOMPLETE',
      run: () => ({ args: ['validate'], cwd: project('orch-validate-error', BROKEN_RESOURCES_WITH_SKILLS, { 'skills/clean/SKILL.md': CLEAN_SKILL }) }),
    },
  ],
  verify: [
    { status: 'ok', run: () => ({ args: ['verify'], cwd: project('orch-verify-ok', RESOURCES_CONFIG, { 'docs/a.md': '# A\n' }) }) },
    { status: 'findings', run: () => ({ args: ['verify'], cwd: project('orch-verify-findings', RESOURCES_CONFIG, { 'docs/a.md': '# A\n\n[gone](./missing.md)\n' }) }) },
    {
      status: 'error',
      code: 'RUN_INCOMPLETE',
      run: () => ({ args: ['verify'], cwd: project('orch-verify-error', BROKEN_RESOURCES_WITH_SKILLS, { 'skills/clean/SKILL.md': CLEAN_SKILL }) }),
    },
  ],
  build: [
    { status: 'ok', run: () => ({ args: ['build'], cwd: project('orch-build-ok', SKILLS_CONFIG, { 'skills/clean/SKILL.md': CLEAN_SKILL }) }) },
    // The skills phase examines nothing (no `skills:` block) and the claude phase
    // warns: integrity is judged on the SUM, so this is findings at exit 0, never
    // the skills phase's own zero-examined refusal.
    {
      status: 'findings',
      run: () => ({ args: ['build'], cwd: project('orch-build-findings', PLUGIN_BUILD_CONFIG('          exclude: ["never/**"]\n'), PLUGIN_BUILD_FILES) }),
    },
    {
      status: 'error',
      code: 'RUN_INCOMPLETE',
      run: () => ({ args: ['build'], cwd: project('orch-build-error', EMPTY_PLUGIN_CONFIG, { 'skills/clean/SKILL.md': CLEAN_SKILL }) }),
    },
  ],
  // Every check passes (or does not apply) in a git project with a config — the
  // version check needs the registry; failing ones are `findings`, exit 1.
  doctor: [
    {
      status: 'ok',
      skipReason: () => (npmReachable() ? undefined : 'the npm registry does not answer, so the version check is undetermined'),
      run: () => ({ args: ['doctor'], cwd: project('doctor-ok', '{}\n') }),
    },
    // Outside any git repository and any config: two checks fail.
    { status: 'findings', run: () => ({ args: ['doctor'], cwd: tempDir }) },
  ],
  'cache clear': [
    {
      status: 'ok',
      run: (): ScenarioRun => {
        writeFileTree(scenarioCacheDir(), { 'external-links.json': '{}' });
        return { args: ['cache', 'clear'], cwd: tempDir };
      },
    },
    // An entry the delete cannot unlink: the clear stops part-way, with what went in `data`.
    {
      status: 'error',
      code: 'RUN_INCOMPLETE',
      skipReason: () => (CANNOT_DENY_READS ? 'this platform or user cannot deny a directory its writes' : undefined),
      run: (): ScenarioRun => {
        writeFileTree(scenarioCacheDir(), { 'stuck/inner.json': '{}' });
        const stuck = safePath.join(scenarioCacheDir(), 'stuck');
        chmodSync(stuck, UNWRITABLE);
        lockedByScenarios.push(stuck);
        return { args: ['cache', 'clear'], cwd: tempDir };
      },
    },
  ],
  'rag index': [
    // A frontmatter-only document indexes as empty — clean, and no embedding model is loaded.
    { status: 'ok', run: () => ({ args: ['rag', 'index', '.', '--db', ragDb('index-ok')], cwd: project('rag-index-ok', '{}\n', { 'docs/a.md': '---\ntitle: A\n---\n' }) }) },
    // A document the crawl cannot read is not in the index: a RAG_DOCUMENT_INDEX_FAILED finding (exit 1).
    {
      status: 'findings',
      skipReason: () => (CANNOT_DENY_READS ? 'this platform or user cannot deny a file its reads' : undefined),
      run: (): ScenarioRun => {
        // Not a git project, to step around a DEFECT (filed): in a git project, `getGitTreeSnapshot`
        // (`utils/src/git-snapshot.ts`, `git add --all` into a temp index) fails on a non-ignored file
        // the OS will not read, and the whole run refuses as INTERNAL_ERROR instead of reporting that
        // one file. Move this row back into a git project once that is fixed.
        const cwd = noProject('rag-index-findings');
        writeFileTree(cwd, { 'vibe-agent-toolkit.config.yaml': '{}\n', 'docs/locked.md': '# Locked\n\nProse nobody can read.\n' });
        const locked = safePath.join(cwd, 'docs', 'locked.md');
        chmodSync(locked, UNREADABLE);
        lockedByScenarios.push(locked);
        return { args: ['rag', 'index', '.', '--db', ragDb('index-findings')], cwd };
      },
    },
    { status: 'error', code: 'USAGE_INVALID', run: () => ({ args: ['rag', 'index'], cwd: noProject('rag-index-error') }) },
  ],
  'rag query': [
    {
      status: 'ok',
      skipReason: noOnnxModelReason,
      run: (home: string): ScenarioRun => {
        linkOnnxModelCache(home);
        const cwd = project('rag-query-ok', '{}\n', { 'docs/a.md': '# Widgets\n\nReviewing widgets in depth.\n' });
        executeCli(MATRIX_BIN_PATH, ['rag', 'index', '.', '--db', ragDb('query-ok')], { cwd, env: { ...process.env, ...scenarioEnv(home) } });
        return { args: ['rag', 'query', 'widgets', '--db', ragDb('query-ok')], cwd };
      },
    },
    // A database nothing was indexed into: the index the query must read holds nothing.
    { status: 'error', code: 'INPUT_UNREADABLE', run: () => ({ args: ['rag', 'query', 'widgets', '--db', ragDb('query-empty')], cwd: noProject('rag-query-error') }) },
  ],
  'rag stats': [
    { status: 'ok', run: () => ({ args: ['rag', 'stats', '--db', ragDb('stats-ok')], cwd: noProject('rag-stats-ok') }) },
    { status: 'error', code: 'USAGE_INVALID', run: () => ({ args: ['rag', 'stats'], cwd: noProject('rag-stats-error') }) },
  ],
  'rag clear': [
    { status: 'ok', run: () => ({ args: ['rag', 'clear', '--db', ragDb('clear-ok')], cwd: noProject('rag-clear-ok') }) },
    { status: 'error', code: 'USAGE_INVALID', run: () => ({ args: ['rag', 'clear'], cwd: noProject('rag-clear-error') }) },
  ],
  'mcp list-collections': [
    { status: 'ok', run: () => ({ args: ['mcp', 'list-collections'], cwd: tempDir }) },
  ],
  'corpus scan': [
    { status: 'ok', run: () => corpusScan('corpus-ok', { 'plugin/skills/clean/SKILL.md': CLEAN_SKILL }, 'plugin') },
    // An entry whose source is not there could not be audited: the scan finished, and says which entry it could not do.
    { status: 'findings', run: () => corpusScan('corpus-findings', {}, 'never-created') },
    { status: 'error', code: 'USAGE_INVALID', run: () => ({ args: ['corpus', 'scan', safePath.join(tempDir, 'no-seed.yaml'), '--out', safePath.join(tempDir, 'corpus-error-out')], cwd: tempDir }) },
  ],
  'ard emit': [
    { status: 'ok', run: () => ({ args: ['ard', 'emit', '--format', 'json'], cwd: project('ard-ok', ARD_CONFIG, { 'skills/clean/SKILL.md': CLEAN_SKILL }) }) },
    // A project with no `ard:` block: a finding about the PROJECT. It used to be
    // the envelope's error branch at exit 1 — the document and the code disagreed.
    { status: 'findings', run: () => ({ args: ['ard', 'emit', '--format', 'json'], cwd: project('ard-findings', '{}\n') }) },
    { status: 'error', code: 'USAGE_INVALID', run: () => ({ args: ['ard', 'emit', '--format', 'json', '--project-root', safePath.join(tempDir, 'never-created')], cwd: tempDir }) },
  ],
};

/**
 * The statuses a verb's envelope can take in principle but no scenario can
 * reach, each with the reason. Per verb, these and the scenarios' statuses are
 * disjoint and together are every status — so a verb either shows a status or
 * says why it cannot, and a status that becomes reachable must move here from
 * a scenario, never vanish.
 */
export const UNREACHABLE_STATUSES: Readonly<Record<string, Partial<Record<ReportStatus, string>>>> = {
  ...ORG_STUB_UNREACHABLE,
  'claude plugin list': {
    findings: 'The listing reports no finding: a registry it cannot read refuses the run, and an absent one is empty.',
  },
  'skill test run': {
    findings: 'A failed eval needs a graded run: a real claude executor and grader session per eval, which spend tokens this suite never spends.',
  },
  'skill test configure': {
    findings: 'The edit reports no finding: an updated config that fails its schema refuses the run (CONFIG_INVALID), and an unknown key is a stderr warning.',
  },
  doctor: {
    error: 'Every check catches its own failure as a fail or undetermined outcome, and doctor takes no argument to mistake: a throw out of the run is a VAT defect (INTERNAL_ERROR) no scenario can provoke.',
  },
  'agent build': {
    findings: 'A completed build carries no finding: it built the one agent (ok), or it could not — the target, the manifest or its sources refuse the run, and a packager refusal is its SKILL_PACKAGING_FAILED finding on the error branch (RUN_INCOMPLETE).',
  },
  'agent import': {
    findings: 'An import reports no finding: it wrote the one agent.yaml (ok), or the SKILL.md, the output or the write refused the run.',
  },
  'agent list': {
    error: 'agent list takes no argument to mistake, and every path it cannot read is a SCAN_PATH_UNREADABLE finding: a throw out of the run is a VAT defect (INTERNAL_ERROR) no scenario can provoke.',
  },
  'agent install': {
    findings: 'An install reports no finding: it installed the one agent (ok), or the invocation, the built bundle or the write refused the run.',
  },
  'agent uninstall': {
    findings: 'An uninstall reports no finding: it removed the one install (ok), or the invocation, an agent that is not installed, or the removal refused the run.',
  },
  'cache clear': {
    findings: 'A clear reports no finding: it removed everything (ok), stopped part-way (RUN_INCOMPLETE), or could not read the cache (INPUT_UNREADABLE).',
  },
  'rag query': {
    findings: 'A query reports no finding: it searched the index (ok, a query matching nothing included) or could not (error).',
  },
  'rag stats': {
    findings: 'Stats reports no finding: it read the one database (ok, zeros for an empty one) or could not open it (error).',
  },
  'rag clear': {
    findings: 'A clear reports no finding: it cleared the one database (ok) or could not open it (error).',
  },
  'mcp list-collections': {
    findings: 'The listing reports no finding: it reads the built-in package list, which cannot be unreadable.',
    error: 'list-collections takes no argument to mistake and reads only a built-in list: a throw out of the run is a VAT defect (INTERNAL_ERROR) no scenario can provoke.',
  },
};

/** The registered envelope verbs, as `PUBLISHED_SHAPES` names them. */
export const REGISTERED_ENVELOPE_VERBS = PUBLISHED_SHAPES.flatMap((entry) => (entry.kind === 'report' ? entry.verbs : []));

/** The document on stdout — JSON or YAML, whichever the verb wrote. */
export function documentOf(stdout: string): ExitDeterminingDocument & Record<string, unknown> {
  return yaml.parse(stdout) as ExitDeterminingDocument & Record<string, unknown>;
}

/**
 * The verb published a document, and it says what its code says: `error`.
 *
 * 🪤 This used to return early on an empty stdout ("…IfAny"), and that escape
 * hatch is exactly how `vat skills validate <missing path>` shipped exiting 2
 * with zero bytes on stdout while this row stayed green. Every document verb
 * publishes its document on failure too.
 */
export function expectErrorDocument(stdout: string, code: RefusalCode | undefined): void {
  expect(stdout.trim(), 'the verb published no document').not.toBe('');
  const document = documentOf(stdout);
  expect(document.status).toBe('error');
  // An envelope verb names WHICH refusal: a user's path is never INTERNAL_ERROR.
  if (code !== undefined) expect(document['error'], stdout).toMatchObject({ code });
}

/**
 * Which spec file runs which verbs' scenarios. Each key is a shard, run by
 * `exit-code-matrix-shard-<key>.system.test.ts` and by nothing else; the values
 * partition {@link ENVELOPE_SCENARIOS}' verbs. Both facts are asserted in
 * `exit-code-matrix.system.test.ts`, so a verb given scenarios and no shard is a
 * red test, as is a shard with no spec file.
 *
 * The grouping is by command family, sized so that each file stays far inside
 * the system tier's per-file budget on the CI floor. A shard that grows toward
 * the budget is split here — never listed on the budget allowlist.
 */
export const MATRIX_SHARDS: Readonly<Record<string, readonly string[]>> = {
  agent: ['agent build', 'agent import', 'agent install', 'agent installed', 'agent list', 'agent uninstall', 'agent validate'],
  audit: ['audit', 'audit settings', 'inventory', 'corpus scan', 'okf validate', 'ard emit'],
  'claude-org': Object.keys(ORG_STUB_OPTIONS),
  'claude-plugin': [
    'claude marketplace publish',
    'claude marketplace validate',
    'claude plugin build',
    'claude plugin install',
    'claude plugin list',
    'claude plugin uninstall',
  ],
  machine: ['doctor', 'cache clear', 'mcp list-collections'],
  orchestrators: ['validate', 'verify', 'build'],
  rag: ['rag index', 'rag query', 'rag stats', 'rag clear'],
  resources: ['resources check', 'resources query', 'resources scan', 'resources validate'],
  'skills-authoring': ['skill review', 'skill test configure', 'skill test run', 'skills validate'],
  'skills-distribution': ['skills build', 'skills install', 'skills list', 'skills package'],
};

/** A shard's spec file name: the one shape {@link exitCodeMatrixShard} accepts and the root file enumerates. */
export const MATRIX_SHARD_FILE = /^exit-code-matrix-shard-(.+)\.system\.test\.ts$/;

/** The shard a spec file is named after — a file that is not a shard file names none, and that is thrown. */
function shardNameOf(specFileUrl: string): string {
  const file = basename(fileURLToPath(specFileUrl));
  const name = MATRIX_SHARD_FILE.exec(file)?.[1];
  if (name === undefined) throw new Error(`${file} is not an exit-code matrix shard file (exit-code-matrix-shard-<name>.system.test.ts)`);
  return name;
}

/** One scenario of the table, with the verb it belongs to — what a shard file runs one test for. */
type MatrixCase = Scenario & { readonly verb: string };

/**
 * Every scenario of every verb {@link MATRIX_SHARDS} assigns to the shard
 * `specFileUrl` is NAMED AFTER. The slice is taken by the file's name, never by
 * an argument, so no file can run another's shard.
 *
 * Throws while the file is collected — a failed file, not zero tests — when the
 * file names no declared shard, the shard names a verb the table lacks, or the
 * shard would run nothing.
 */
export function exitCodeMatrixShard(specFileUrl: string): readonly MatrixCase[] {
  const shard = shardNameOf(specFileUrl);
  const verbs = MATRIX_SHARDS[shard];
  if (verbs === undefined) throw new Error(`MATRIX_SHARDS declares no shard named "${shard}"`);

  const cases = verbs.flatMap((verb) => {
    const scenarios = ENVELOPE_SCENARIOS[verb];
    if (scenarios === undefined) throw new Error(`shard "${shard}" names "${verb}", which ENVELOPE_SCENARIOS has no scenarios for`);
    return scenarios.map((scenario) => ({ verb, ...scenario }));
  });
  if (cases.length === 0) throw new Error(`shard "${shard}" runs no scenario`);
  return cases;
}

/**
 * Run one scenario under its own fake HOME and expect: the status the scenario
 * names, the refusal code an `error` names, the gate in the document, and the
 * exit code that document derives. A scenario this platform cannot run is
 * skipped with its reason — it is still a test of the shard, never absent.
 */
export function expectScenarioEndsOnItsDerivedCode(scenario: MatrixCase, context: TestContext): void {
  const skipReason = scenario.skipReason?.();
  if (skipReason !== undefined) context.skip(skipReason);

  const home = safePath.join(tempDir, 'homes', `${scenario.verb.replaceAll(' ', '-')}-${scenario.status}`);
  mkdirSyncReal(home, { recursive: true });
  const { args, cwd } = scenario.run(home);
  const result = executeCli(MATRIX_BIN_PATH, args, { cwd, env: { ...process.env, ...scenarioEnv(home) } });
  const document = documentOf(result.stdout);

  expect(document.status, `${result.stdout}\n${result.stderr}`).toBe(scenario.status);
  if (scenario.status === 'error') {
    expect(document['error'], `${result.stdout}\n${result.stderr}`).toMatchObject({ code: scenario.code });
  }
  // The gate is IN the document — the exit code derives from nothing else.
  expect(document.gate, `${result.stdout}\n${result.stderr}`).toStrictEqual({ strict: expect.any(Boolean) });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(exitCodeForReport(document));
}

/** The per-test timeout of a scenario: one spawn of the built CLI, two for the scenario that indexes first. */
export const MATRIX_SCENARIO_TIMEOUT_MS = 60_000;
