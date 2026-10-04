/**
 * The exit code is DERIVED from the published document — observed, verb by verb.
 *
 * ## The class this pins
 *
 * Every verb used to choose its exit code at its own call site, so one outcome
 * got different codes in different verbs: a `resources check` budget kill was 1
 * or 2 depending on timing, `vat ard emit` published the envelope's `status:
 * error` at exit 1, and `vat audit` over a root the OS would not list exited 1
 * where `resources validate`, `check`, `query` and `scan` exit 2. The fix is ONE
 * derivation, `exitCodeForReport(document)`; the lint rule
 * `no-literal-process-exit` (`derived`) refuses a code decided beside the
 * document, and this file proves, by running the verbs, that the code each one
 * ends on IS the code its document derives.
 *
 * ## What is enumerated, and asserted both ways
 *
 * - Every `report` entry of `PUBLISHED_SHAPES` — the registered commands whose
 *   document is the envelope — has scenarios here, one per status the envelope
 *   can take, and no scenario names a verb that is not registered. Adding an
 *   envelope verb without adding it here is a red test, not a silent gap.
 * - Every `error` scenario names the refusal code its document must carry: a
 *   user's mistake published as `INTERNAL_ERROR` reads as a VAT bug.
 * - Every outcome of every `external` entry's adapter maps to its code, and
 *   the adapter's table and this file's cases match both ways.
 * - One OUTCOME across every document verb that takes a path: a path that does
 *   not exist, and a directory the OS will not list. Each is the invocation's
 *   mistake — nothing could be examined — so each ends on 2 in every verb.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

import {
  exitCodeForReport,
  ExitCode,
  REPORT_STATUSES,
  type ExitDeterminingDocument,
  type RefusalCode,
  type ReportStatus,
} from '@vibe-agent-toolkit/schema';
import { createSymlink, mkdirSyncReal, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS, gitExecutable } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yaml from 'yaml';

import { exitCodeForExternal, PUBLISHED_SHAPES, type ExternalOutcome } from '../../src/report-schemas.js';

import { cleanupTestTempDir, createTestTempDir, fakeHomeEnv, getBinPath, writeFileTree } from './test-common.js';
import { executeCli } from './test-helpers/index.js';

const binPath = getBinPath(import.meta.url);

/** A directory's mode bits when nothing may read or enter it, and when everything may. */
const UNREADABLE = 0o000;
const READABLE = 0o755;
/** A directory whose entries cannot be removed: listable, enterable, not writable. */
const UNWRITABLE = 0o555;

let tempDir: string;

/** Alphabetical, spelled out so the sort does not depend on the default comparator. */
const byName = (a: string, b: string): number => a.localeCompare(b);

/** A git project under the suite's temp dir, with a config and the given files. */
function project(name: string, config: string, files: Readonly<Record<string, string>> = {}): string {
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
const HAS_CLAUDE = spawnSync('claude', ['--version'], { stdio: 'ignore' }).status === 0;
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
const SKILLS_INSTALL_FLAGS = ['--target', 'claude', '--scope', 'project'] as const;

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
 * deletes it, and nothing in this file may delete the developer's (or a sibling
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
const NPM_REACHABLE = spawnSync('npm', ['view', 'vibe-agent-toolkit', 'version'], {
  stdio: 'ignore',
  shell: process.platform === 'win32',
  timeout: 30_000,
}).status === 0;

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
function ragDb(name: string): string {
  return safePath.join(tempDir, 'rag-dbs', name);
}

/**
 * `vat corpus scan` over a one-entry seed naming `source` under a fresh
 * directory holding `files`, into `--out` beside it. The verb publishes YAML;
 * it takes no `--format`.
 */
function corpusScan(name: string, files: Readonly<Record<string, string>>, source: string): { args: string[]; cwd: string } {
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

/** One run of one envelope verb, and the status its document must carry. */
interface ScenarioBase {
  /**
   * The verb's arguments and working directory, built inside the suite's temp
   * dir. `home` is this scenario's own fresh fake HOME — every scenario runs
   * under one, so no verb in this file can read or mutate the developer's real
   * `~/.claude`; a scenario that needs installed state seeds it there. A
   * scenario that needs cache state seeds it under {@link scenarioCacheDir}.
   */
  readonly run: (home: string) => { args: string[]; cwd: string };
  /** Why this scenario cannot run on this platform — it still counts as present. */
  readonly skipReason?: string | undefined;
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
const ENVELOPE_SCENARIOS: Readonly<Record<string, readonly Scenario[]>> = {
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
      skipReason: CANNOT_DENY_READS ? 'this platform cannot deny a directory listing' : undefined,
      run: () => {
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
      skipReason: HAS_CLAUDE ? undefined : 'no claude binary on PATH: the harness preflight refuses before it stages',
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
      skipReason: CANNOT_DENY_READS ? 'this platform cannot deny a directory listing' : undefined,
      run: (home) => {
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
      skipReason: CANNOT_DENY_READS ? 'this platform cannot deny a directory listing' : undefined,
      run: () => {
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
      run: (home) => {
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
      skipReason: CANNOT_DENY_READS ? 'this platform cannot deny a directory listing' : undefined,
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
      skipReason: DEV_INSTALL_SKIP,
      run: () => ({ args: ['claude', 'plugin', 'install', '--dev'], cwd: project('install-findings', '{}\n', UNBUILT_PLUGIN_FILES) }),
    },
    { status: 'error', code: 'NOT_IMPLEMENTED', run: () => ({ args: ['claude', 'plugin', 'install', 'npm:@matrix/none', '--target', 'claude.ai'], cwd: tempDir }) },
  ],
  'claude plugin uninstall': [
    // Not installed: uninstall is idempotent, and nothing to remove is an answer.
    { status: 'ok', run: () => ({ args: ['claude', 'plugin', 'uninstall', 'p@matrix-mp'], cwd: tempDir }) },
    {
      status: 'findings',
      run: (home) => {
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
      skipReason: NPM_REACHABLE ? undefined : 'the npm registry does not answer, so the version check is undetermined',
      run: () => ({ args: ['doctor'], cwd: project('doctor-ok', '{}\n') }),
    },
    // Outside any git repository and any config: two checks fail.
    { status: 'findings', run: () => ({ args: ['doctor'], cwd: tempDir }) },
  ],
  'cache clear': [
    {
      status: 'ok',
      run: () => {
        writeFileTree(scenarioCacheDir(), { 'external-links.json': '{}' });
        return { args: ['cache', 'clear'], cwd: tempDir };
      },
    },
    // An entry the delete cannot unlink: the clear stops part-way, with what went in `data`.
    {
      status: 'error',
      code: 'RUN_INCOMPLETE',
      skipReason: CANNOT_DENY_READS ? 'this platform or user cannot deny a directory its writes' : undefined,
      run: () => {
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
      skipReason: CANNOT_DENY_READS ? 'this platform or user cannot deny a file its reads' : undefined,
      run: () => {
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
      skipReason: noOnnxModelReason(),
      run: (home) => {
        linkOnnxModelCache(home);
        const cwd = project('rag-query-ok', '{}\n', { 'docs/a.md': '# Widgets\n\nReviewing widgets in depth.\n' });
        executeCli(binPath, ['rag', 'index', '.', '--db', ragDb('query-ok')], { cwd, env: { ...process.env, ...scenarioEnv(home) } });
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
const UNREACHABLE_STATUSES: Readonly<Record<string, Partial<Record<ReportStatus, string>>>> = {
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
const REGISTERED_ENVELOPE_VERBS = PUBLISHED_SHAPES.flatMap((entry) => (entry.kind === 'report' ? entry.verbs : []));

/** The registered external verbs — the passed-through Admin API payloads, whose code an adapter decides. */
const REGISTERED_EXTERNAL_VERBS = PUBLISHED_SHAPES.flatMap((entry) => (entry.kind === 'external' ? entry.verbs : []));

/** One case per outcome an external adapter maps: only a write that fully landed is OK. */
const EXTERNAL_OUTCOMES: Readonly<Record<ExternalOutcome['kind'], { outcome: ExternalOutcome; code: number }>> = {
  ok: { outcome: { kind: 'ok' }, code: ExitCode.OK },
  partial: { outcome: { kind: 'partial', failed: 1 }, code: ExitCode.ERROR },
  failed: { outcome: { kind: 'failed', cause: 'refused' }, code: ExitCode.ERROR },
};

/** The document on stdout — JSON or YAML, whichever the verb wrote. */
function documentOf(stdout: string): ExitDeterminingDocument & Record<string, unknown> {
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
function expectErrorDocument(stdout: string, code: RefusalCode | undefined): void {
  expect(stdout.trim(), 'the verb published no document').not.toBe('');
  const document = documentOf(stdout);
  expect(document.status).toBe('error');
  // An envelope verb names WHICH refusal: a user's path is never INTERNAL_ERROR.
  if (code !== undefined) expect(document['error'], stdout).toMatchObject({ code });
}

/**
 * The refusal each ENVELOPE verb among {@link PATH_VERBS} publishes for the two
 * outcomes — keyed by the registry's verb name and asserted both ways below, so
 * a verb that turns `report` must add its row here.
 */
const PATH_REFUSALS: Readonly<Record<string, { readonly missing: RefusalCode; readonly unreadable: RefusalCode }>> = {
  audit: { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  'audit settings': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  'resources check': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  'resources query': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  'resources scan': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  'resources validate': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  'skill review': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  'skills validate': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  'skills build': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  'skills package': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  'claude marketplace validate': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  'agent validate': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  'skills list': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  'skills install': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  'agent import': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  'rag index': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  inventory: { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
};

/**
 * Every document verb whose path argument is WHERE TO LOOK — a root to scan, a
 * project to locate, a subject to review. A path that names nothing, and a
 * directory the OS will not list, are the same OUTCOME in all of them.
 *
 * ⚠️ `vat claude context [paths...]` is not here, and not by oversight: its
 * paths are QUESTIONS ("what loads at X?"), not a root, and a path the
 * projection never realized is answered with a `kind: unknown` document at exit
 * 0 by design. Whether an unanswerable question should end on 2 is a separate
 * decision about that verb, not this outcome.
 */
const PATH_VERBS: ReadonlyArray<{ readonly verb: string; readonly args: (path: string) => string[] }> = [
  { verb: 'resources validate', args: (path) => ['resources', 'validate', path] },
  { verb: 'resources scan', args: (path) => ['resources', 'scan', path] },
  { verb: 'resources check', args: (path) => ['resources', 'check', path] },
  { verb: 'resources query', args: (path) => ['resources', 'query', 'SELECT 1', path] },
  { verb: 'audit', args: (path) => ['audit', path] },
  // `--file` names the one document to examine: absent is the invocation's mistake, unreadable is the input's.
  { verb: 'audit settings', args: (path) => ['audit', 'settings', '--file', path] },
  { verb: 'skills validate', args: (path) => ['skills', 'validate', path] },
  { verb: 'skills build', args: (path) => ['skills', 'build', path] },
  // The SKILL.md (or its directory) to package: checked before the project root, since it is the argument.
  { verb: 'skills package', args: (path) => ['skills', 'package', path, '-o', safePath.join(tempDir, 'package-path-out')] },
  { verb: 'skill review', args: (path) => ['skill', 'review', path, '--yaml'] },
  { verb: 'claude marketplace validate', args: (path) => ['claude', 'marketplace', 'validate', path] },
  { verb: 'agent validate', args: (path) => ['agent', 'validate', path] },
  { verb: 'skills list', args: (path) => ['skills', 'list', path] },
  // The source to install: a directory the OS will not list cannot be looked into for a SKILL.md.
  { verb: 'skills install', args: (path) => ['skills', 'install', path, ...SKILLS_INSTALL_FLAGS] },
  // The SKILL.md to convert: a directory, listable or not, cannot be read as one.
  { verb: 'agent import', args: (path) => ['agent', 'import', path] },
  // The root to crawl; `--db` so the database path is never what refuses.
  { verb: 'rag index', args: (path) => ['rag', 'index', path, '--db', ragDb('path-verb')] },
  // The subject to inventory: a plugin, marketplace or install directory, or a SKILL.md.
  { verb: 'inventory', args: (path) => ['inventory', path] },
];

/**
 * Run `verb` over `target` with `locked` made unreadable, and expect the verb's
 * `unreadable` refusal at exit 2. The mode is restored either way.
 */
function expectUnreadableRefusal(verb: string, args: (path: string) => string[], target: string, locked: string): void {
  mkdirSyncReal(target, { recursive: true });
  chmodSync(locked, UNREADABLE);
  try {
    const result = executeCli(binPath, args(target), { cwd: tempDir });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(ExitCode.ERROR);
    expectErrorDocument(result.stdout, PATH_REFUSALS[verb]?.unreadable);
  } finally {
    chmodSync(locked, READABLE);
  }
}

/**
 * Run `args` in a directory holding only a `vibe-agent-toolkit.config.yaml` made
 * by `makeConfig`, and expect `INPUT_UNREADABLE` at exit 2. The mode is restored either way.
 */
function expectConfigRefusal(name: string, args: readonly string[], makeConfig: (configPath: string) => void): void {
  const cwd = safePath.join(tempDir, name);
  mkdirSyncReal(cwd, { recursive: true });
  const configPath = safePath.join(cwd, 'vibe-agent-toolkit.config.yaml');
  makeConfig(configPath);
  try {
    const result = executeCli(binPath, [...args], { cwd });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(ExitCode.ERROR);
    expectErrorDocument(result.stdout, 'INPUT_UNREADABLE');
  } finally {
    if (existsSync(configPath)) chmodSync(configPath, READABLE);
  }
}

/** A project declaring `guides`, holding one file, and `empty`, which no file matches. */
const COLLECTION_CONFIG = 'resources:\n  collections:\n    guides:\n      include:\n        - "docs/*.md"\n'
  + '    empty:\n      include:\n        - "nothing/*.md"\n';

/** The verbs taking `--collection`: one flag, one meaning — an undeclared name is the invocation's mistake. */
const COLLECTION_VERBS: ReadonlyArray<{ readonly verb: string; readonly args: readonly string[] }> = [
  { verb: 'resources validate', args: ['resources', 'validate', '--format', 'json'] },
  { verb: 'resources scan', args: ['resources', 'scan', '--format', 'json'] },
];

describe('exit codes are derived from the published document (system test)', () => {
  beforeAll(() => {
    tempDir = createTestTempDir('vat-exit-matrix-');
  });

  afterAll(() => {
    for (const locked of lockedByScenarios) chmodSync(locked, READABLE);
    cleanupTestTempDir(tempDir);
  });

  it('covers EXACTLY the registered envelope verbs — no more, no fewer', () => {
    expect(Object.keys(ENVELOPE_SCENARIOS).sort(byName)).toStrictEqual([...REGISTERED_ENVELOPE_VERBS].sort(byName));
  });

  it('gives every envelope verb one scenario per status, or the reason a status is unreachable', () => {
    for (const [verb, scenarios] of Object.entries(ENVELOPE_SCENARIOS)) {
      const shown = scenarios.map((scenario) => scenario.status);
      const unreachable = Object.keys(UNREACHABLE_STATUSES[verb] ?? {});
      expect(shown.filter((status) => unreachable.includes(status)), verb).toStrictEqual([]);
      expect([...shown, ...unreachable].sort(byName), verb).toStrictEqual([...REPORT_STATUSES].sort(byName));
    }
  });

  it('declares unreachable statuses only for envelope verbs', () => {
    expect(Object.keys(UNREACHABLE_STATUSES).filter((verb) => !REGISTERED_ENVELOPE_VERBS.includes(verb))).toStrictEqual([]);
  });

  const cases = Object.entries(ENVELOPE_SCENARIOS).flatMap(([verb, scenarios]) =>
    scenarios.map((scenario) => ({ verb, ...scenario })),
  );

  for (const scenario of cases) {
    it.skipIf(scenario.skipReason !== undefined)(`${scenario.verb} → ${scenario.status} ends on the code its document derives`, () => {
      const home = safePath.join(tempDir, 'homes', `${scenario.verb.replaceAll(' ', '-')}-${scenario.status}`);
      mkdirSyncReal(home, { recursive: true });
      const { args, cwd } = scenario.run(home);
      const result = executeCli(binPath, args, { cwd, env: { ...process.env, ...scenarioEnv(home) } });
      const document = documentOf(result.stdout);

      expect(document.status, `${result.stdout}\n${result.stderr}`).toBe(scenario.status);
      if (scenario.status === 'error') {
        expect(document['error'], `${result.stdout}\n${result.stderr}`).toMatchObject({ code: scenario.code });
      }
      // The gate is IN the document — the exit code derives from nothing else.
      expect(document.gate, `${result.stdout}\n${result.stderr}`).toStrictEqual({ strict: expect.any(Boolean) });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(exitCodeForReport(document));
    }, 60_000);
  }

  /**
   * An external verb has no envelope to derive a code from, so its entry's
   * adapter maps what the Admin API write did to the code. Only `failed` is
   * reachable by a spawned CLI — the org client has no base-URL override, so
   * `ok` and `partial` need the live API — so the table is asserted for every
   * verb through the adapter itself, and `failed` is also observed end to end.
   */
  describe('external verbs: the adapter decides the code', () => {
    it('covers every external adapter outcome', () => {
      const externals = PUBLISHED_SHAPES.filter((entry) => entry.kind === 'external');
      expect(externals.length).toBeGreaterThan(0);
      for (const entry of externals) {
        // Both ways: every outcome the adapter maps has a case here, and every case is one it maps.
        expect(Object.keys(entry.exitCodes).sort(byName), entry.verbs.join(', ')).toStrictEqual(Object.keys(EXTERNAL_OUTCOMES).sort(byName));
      }
      for (const verb of REGISTERED_EXTERNAL_VERBS) {
        for (const [kind, { outcome, code }] of Object.entries(EXTERNAL_OUTCOMES)) {
          expect(exitCodeForExternal(verb, outcome), `${verb} ${kind}`).toBe(code);
        }
      }
    });

    it('claude org info with no admin key publishes its USAGE_INVALID refusal and ends on the adapter\'s failed code', () => {
      const home = safePath.join(tempDir, 'homes', 'external-org-info');
      mkdirSyncReal(home, { recursive: true });
      const env = { ...process.env, ...fakeHomeEnv(home), ANTHROPIC_ADMIN_API_KEY: '', ANTHROPIC_API_KEY: '' };
      const result = executeCli(binPath, ['claude', 'org', 'info'], { cwd: tempDir, env });

      expect(documentOf(result.stdout), `${result.stdout}\n${result.stderr}`).toMatchObject({ error: { code: 'USAGE_INVALID' } });
      expect(result.status).toBe(exitCodeForExternal('claude org info', { kind: 'failed', cause: 'refused' }));
    });
  });

  it.each(COLLECTION_VERBS)('$verb refuses a --collection the project does not declare as USAGE_INVALID', ({ verb, args }) => {
    const cwd = project(`collection-${verb.replace(' ', '-')}`, COLLECTION_CONFIG, { 'docs/a.md': '# A\n' });
    const result = executeCli(binPath, [...args, '--collection', 'guidez'], { cwd });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(ExitCode.ERROR);
    expectErrorDocument(result.stdout, 'USAGE_INVALID');
    expect(result.stderr).toContain('declared: guides, empty');
  });

  // A DECLARED collection no file matched is not the invocation's mistake — it
  // is a run over nothing, which the writer refuses as a finding (exit 1).
  it.each(COLLECTION_VERBS)('$verb over a declared collection no file matched ends on 1 with RESOURCE_CHECK_BROKEN', ({ verb, args }) => {
    const cwd = project(`collection-empty-${verb.replace(' ', '-')}`, COLLECTION_CONFIG, { 'docs/a.md': '# A\n' });
    const result = executeCli(binPath, [...args, '--collection', 'empty'], { cwd });
    const document = documentOf(result.stdout);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(ExitCode.FINDINGS);
    expect(document.status).toBe('findings');
    expect((document['findings'] as { code: string }[]).map((finding) => finding.code)).toEqual(['RESOURCE_CHECK_BROKEN']);
  });

  describe('ONE outcome, one code: a path argument nothing can be examined under', () => {
    it('names a refusal for EXACTLY the envelope verbs among the path verbs', () => {
      const envelopePathVerbs = PATH_VERBS.map(({ verb }) => verb).filter((verb) => REGISTERED_ENVELOPE_VERBS.includes(verb));
      expect(Object.keys(PATH_REFUSALS).toSorted(byName)).toStrictEqual(envelopePathVerbs.toSorted(byName));
    });

    it.each(PATH_VERBS)('$verb over a path that does not exist ends on ERROR', ({ verb, args }) => {
      const result = executeCli(binPath, args(safePath.join(tempDir, 'never-created')), { cwd: tempDir });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(ExitCode.ERROR);
      expectErrorDocument(result.stdout, PATH_REFUSALS[verb]?.missing);
    });

    it.skipIf(CANNOT_DENY_READS).each(PATH_VERBS)(
      '$verb over a directory the OS will not list ends on ERROR',
      ({ verb, args }) => {
        const locked = safePath.join(tempDir, 'locked');
        expectUnreadableRefusal(verb, args, locked, locked);
      },
    );

    // Under a parent the process may not traverse, the path cannot be stat'ed:
    // whether it exists is unknown, so it is the INPUT's refusal — never "does
    // not exist", and never a scan that starts anyway. One absent-vs-unreadable
    // predicate (`unstatablePathRefusal` in project-root-policy.ts) decides it.
    it.skipIf(CANNOT_DENY_READS).each(PATH_VERBS)(
      '$verb over a path under a parent the OS will not traverse ends on ERROR',
      ({ verb, args }) => {
        const parent = safePath.join(tempDir, 'untraversable');
        expectUnreadableRefusal(verb, args, safePath.join(parent, 'child'), parent);
      },
    );
  });

  // The verbs that read the project config through resources' `parseConfigFile`
  // (the CLI's own loader has always coded this): a config the OS will not read
  // is the user's input — INPUT_UNREADABLE, never INTERNAL_ERROR with a stack.
  describe('a project config the OS will not read is INPUT_UNREADABLE', () => {
    const CONFIG_READERS: ReadonlyArray<{ readonly verb: string; readonly args: readonly string[] }> = [
      { verb: 'okf validate', args: ['okf', 'validate', '--format', 'json'] },
      { verb: 'claude plugin build', args: ['claude', 'plugin', 'build'] },
      { verb: 'claude marketplace publish', args: ['claude', 'marketplace', 'publish', '--dry-run'] },
    ];

    // A directory where the file should be: EISDIR on every platform.
    it.each(CONFIG_READERS)('$verb with a directory at the config path ends on ERROR', ({ verb, args }) => {
      expectConfigRefusal(`config-dir-${verb.replaceAll(' ', '-')}`, args, (configPath) => mkdirSyncReal(configPath));
    });

    it.skipIf(CANNOT_DENY_READS).each(CONFIG_READERS)('$verb with a mode-000 config ends on ERROR', ({ verb, args }) => {
      expectConfigRefusal(`config-000-${verb.replaceAll(' ', '-')}`, args, (configPath) => {
        writeFileSync(configPath, '{}\n');
        chmodSync(configPath, UNREADABLE);
      });
    });
  });
});
