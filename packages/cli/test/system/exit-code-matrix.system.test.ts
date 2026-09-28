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
 * - One OUTCOME across every document verb that takes a path: a path that does
 *   not exist, and a directory the OS will not list. Each is the invocation's
 *   mistake — nothing could be examined — so each ends on 2 in every verb.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  exitCodeForReport,
  ExitCode,
  REPORT_STATUSES,
  type ExitDeterminingDocument,
  type RefusalCode,
  type ReportStatus,
} from '@vibe-agent-toolkit/schema';
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS, gitExecutable } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yaml from 'yaml';

import { PUBLISHED_SHAPES } from '../../src/report-schemas.js';

import { cleanupTestTempDir, createTestTempDir, getBinPath } from './test-common.js';
import { executeCli } from './test-helpers/index.js';

const binPath = getBinPath(import.meta.url);

/** A directory's mode bits when nothing may read or enter it, and when everything may. */
const UNREADABLE = 0o000;
const READABLE = 0o755;

let tempDir: string;

/** Alphabetical, spelled out so the sort does not depend on the default comparator. */
const byName = (a: string, b: string): number => a.localeCompare(b);

/** A git project under the suite's temp dir, with a config and the given files. */
function project(name: string, config: string, files: Readonly<Record<string, string>> = {}): string {
  const dir = safePath.join(tempDir, name);
  mkdirSyncReal(dir, { recursive: true });
  writeFileSync(safePath.join(dir, 'vibe-agent-toolkit.config.yaml'), config, 'utf-8');
  for (const [relative, content] of Object.entries(files)) {
    const target = safePath.join(dir, relative);
    mkdirSyncReal(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf-8');
  }
  spawnSync(gitExecutable(), ['init', '--quiet'], { cwd: dir });
  spawnSync(gitExecutable(), ['add', '.'], { cwd: dir });
  return dir;
}

/** A SKILL.md nothing complains about at error or warning severity. */
const CLEAN_SKILL = '---\nname: clean\ndescription: Reviews widgets for quality. Use when a reviewer wants a '
  + 'checklist walkthrough of a widget in depth.\n---\n\n# clean\n\nPurpose statement goes here.\n\nDoes one thing well.\n';
/** A SKILL.md with an error-severity finding: a description past the 1024-character limit. */
const BROKEN_SKILL = `---\nname: broken\ndescription: Reviews widgets. ${'Use when a reviewer wants a walkthrough. '.repeat(30)}\n---\n\n# broken\n\nBody.\n`;

const OKF_CONFIG = 'version: 1\nokf:\n  bundles:\n    knowledge:\n      root: ./bundles/knowledge\n';
/**
 * One declared skill, so the manifest advertises something: an `ard:` block
 * over no surface examines nothing, and the writer refuses that run.
 */
const ARD_CONFIG = 'version: 1\nskills:\n  include: ["skills/**/SKILL.md"]\n  config:\n    clean: {}\n'
  + 'ard:\n  publisher: example.com\n  baseUrl: https://example.com/catalog\n';
const CHECK_CONFIG = (sql: string): string =>
  `version: 1\nresources:\n  checks:\n    probe:\n      description: probe\n      sql: "${sql}"\n`;
/** A tree whose markdown git ignores wholesale: the population enumerates nothing. */
const NOTHING_TRACKED = { '.gitignore': '*\n', 'docs/a.md': '# A\n' } as const;
/** A project whose `skills:` block discovers every `skills/<name>/SKILL.md`. */
const SKILLS_CONFIG = 'version: 1\nskills:\n  include: ["skills/*/SKILL.md"]\n';
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

/** One run of one envelope verb, and the status its document must carry. */
interface ScenarioBase {
  /** The verb's arguments and working directory, built inside the suite's temp dir. */
  readonly run: () => { args: string[]; cwd: string };
}

/** An `error` scenario names its refusal code; a completed one has none to name. */
type Scenario =
  | (ScenarioBase & { readonly status: Exclude<ReportStatus, 'error'> })
  | (ScenarioBase & { readonly status: 'error'; readonly code: RefusalCode });

/**
 * The envelope verbs, keyed exactly as `PUBLISHED_SHAPES` names them. Every
 * scenario asks for a machine document (`--format json` or `--yaml`) so the
 * code can be compared with what was published.
 */
const ENVELOPE_SCENARIOS: Readonly<Record<string, readonly Scenario[]>> = {
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
  audit: [
    { status: 'ok', run: () => ({ args: ['audit', '.'], cwd: project('audit-ok', 'version: 1\n', { 'skills/clean/SKILL.md': CLEAN_SKILL }) }) },
    // An error-severity finding is `findings` at exit 1 — `error` is reserved for a run that did not finish.
    { status: 'findings', run: () => ({ args: ['audit', '.'], cwd: project('audit-findings', 'version: 1\n', { 'skills/broken/SKILL.md': BROKEN_SKILL }) }) },
    { status: 'error', code: 'USAGE_INVALID', run: () => ({ args: ['audit', 'never-created'], cwd: project('audit-error', 'version: 1\n') }) },
  ],
  'audit settings': [
    {
      status: 'ok',
      run: () => ({ args: ['audit', 'settings', '--file', 'settings.json', '--type', 'project'], cwd: project('settings-ok', 'version: 1\n', { 'settings.json': '{}\n' }) }),
    },
    {
      status: 'findings',
      run: () => ({
        args: ['audit', 'settings', '--file', 'settings.json', '--type', 'project'],
        cwd: project('settings-findings', 'version: 1\n', { 'settings.json': '{"permissions": 5}\n' }),
      }),
    },
    // A `--type` the command does not know is the invocation's mistake.
    {
      status: 'error',
      code: 'USAGE_INVALID',
      run: () => ({ args: ['audit', 'settings', '--file', 'settings.json', '--type', 'bogus'], cwd: project('settings-error', 'version: 1\n', { 'settings.json': '{}\n' }) }),
    },
  ],
  'skill review': [
    { status: 'ok', run: () => ({ args: ['skill', 'review', 'SKILL.md', '--yaml'], cwd: project('review-ok', 'version: 1\n', { 'SKILL.md': CLEAN_SKILL }) }) },
    { status: 'findings', run: () => ({ args: ['skill', 'review', 'SKILL.md', '--yaml'], cwd: project('review-findings', 'version: 1\n', { 'SKILL.md': BROKEN_SKILL }) }) },
    // A path argument that names nothing is the invocation's mistake — never INTERNAL_ERROR.
    { status: 'error', code: 'USAGE_INVALID', run: () => ({ args: ['skill', 'review', 'never-created', '--yaml'], cwd: project('review-error', 'version: 1\n') }) },
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
    { status: 'ok', run: () => ({ args: ['resources', 'validate', '--format', 'json'], cwd: project('validate-ok', 'version: 1\n', { 'docs/a.md': '# A\n' }) }) },
    {
      status: 'findings',
      run: () => ({ args: ['resources', 'validate', '--format', 'json'], cwd: project('validate-findings', 'version: 1\n', { 'docs/a.md': '# A\n\n[gone](./missing.md)\n' }) }),
    },
    // `--frontmatter-schema` naming no file is the invocation's mistake.
    {
      status: 'error',
      code: 'USAGE_INVALID',
      run: () => ({
        args: ['resources', 'validate', '--frontmatter-schema', 'never-created.json', '--format', 'json'],
        cwd: project('validate-error', 'version: 1\n', { 'docs/a.md': '# A\n' }),
      }),
    },
  ],
  'resources scan': [
    { status: 'ok', run: () => ({ args: ['resources', 'scan', '--format', 'json'], cwd: project('scan-ok', 'version: 1\n', { 'docs/a.md': '# A\n' }) }) },
    // Nothing scanned: the writer's run-integrity refusal is the finding.
    { status: 'findings', run: () => ({ args: ['resources', 'scan', 'docs', '--format', 'json'], cwd: project('scan-findings', 'version: 1\n', { 'docs/notes.txt': 'not markdown\n' }) }) },
    { status: 'error', code: 'USAGE_INVALID', run: () => ({ args: ['resources', 'scan', 'never-created', '--format', 'json'], cwd: project('scan-error', 'version: 1\n') }) },
  ],
  'resources query': [
    // Zero rows over a populated tree is an answer, not a finding.
    {
      status: 'ok',
      run: () => ({
        args: ['resources', 'query', "SELECT path FROM resource_realizations WHERE ext = '.txt'", '--format', 'json'],
        cwd: project('query-ok', 'version: 1\n', { 'docs/a.md': '# A\n' }),
      }),
    },
    // A population of nothing answers nothing: the writer's run-integrity refusal.
    {
      status: 'findings',
      run: () => ({ args: ['resources', 'query', 'SELECT 1 AS one', '--format', 'json'], cwd: project('query-findings', 'version: 1\n', NOTHING_TRACKED) }),
    },
    // A statement naming a column the projection lacks is the invocation's mistake.
    {
      status: 'error',
      code: 'USAGE_INVALID',
      run: () => ({
        args: ['resources', 'query', 'SELECT no_such_column FROM resource_realizations', '--format', 'json'],
        cwd: project('query-error', 'version: 1\n', { 'docs/a.md': '# A\n' }),
      }),
    },
  ],
  'skills validate': [
    { status: 'ok', run: () => ({ args: ['skills', 'validate'], cwd: project('skills-ok', SKILLS_CONFIG, { 'skills/clean/SKILL.md': CLEAN_SKILL }) }) },
    { status: 'findings', run: () => ({ args: ['skills', 'validate'], cwd: project('skills-findings', SKILLS_CONFIG, { 'skills/broken/SKILL.md': BROKEN_SKILL }) }) },
    // A `[path]` that names no directory is the invocation's mistake.
    { status: 'error', code: 'USAGE_INVALID', run: () => ({ args: ['skills', 'validate', 'never-created'], cwd: project('skills-error', SKILLS_CONFIG) }) },
  ],
  'claude marketplace validate': [
    { status: 'ok', run: () => ({ args: ['claude', 'marketplace', 'validate', '.'], cwd: project('marketplace-ok', 'version: 1\n', MARKETPLACE_FILES) }) },
    // No LICENSE: an error-severity finding about the marketplace, exit 1.
    {
      status: 'findings',
      run: () => ({
        args: ['claude', 'marketplace', 'validate', '.'],
        cwd: project('marketplace-findings', 'version: 1\n', Object.fromEntries(Object.entries(MARKETPLACE_FILES).filter(([file]) => file !== 'LICENSE'))),
      }),
    },
    { status: 'error', code: 'USAGE_INVALID', run: () => ({ args: ['claude', 'marketplace', 'validate', 'never-created'], cwd: project('marketplace-error', 'version: 1\n') }) },
  ],
  'agent validate': [
    { status: 'ok', run: () => ({ args: ['agent', 'validate', './agent'], cwd: project('agent-ok', 'version: 1\n', { 'agent/agent.yaml': AGENT_MANIFEST }) }) },
    // A manifest the schema rejects is a finding about the manifest, exit 1.
    {
      status: 'findings',
      run: () => ({ args: ['agent', 'validate', './agent'], cwd: project('agent-findings', 'version: 1\n', { 'agent/agent.yaml': 'metadata:\n  name: x\nspec:\n  llm: 5\n' }) }),
    },
    { status: 'error', code: 'USAGE_INVALID', run: () => ({ args: ['agent', 'validate', './never-created'], cwd: project('agent-error', 'version: 1\n') }) },
  ],
  'ard emit': [
    { status: 'ok', run: () => ({ args: ['ard', 'emit', '--format', 'json'], cwd: project('ard-ok', ARD_CONFIG, { 'skills/clean/SKILL.md': CLEAN_SKILL }) }) },
    // A project with no `ard:` block: a finding about the PROJECT. It used to be
    // the envelope's error branch at exit 1 — the document and the code disagreed.
    { status: 'findings', run: () => ({ args: ['ard', 'emit', '--format', 'json'], cwd: project('ard-findings', 'version: 1\n') }) },
    { status: 'error', code: 'USAGE_INVALID', run: () => ({ args: ['ard', 'emit', '--format', 'json', '--project-root', safePath.join(tempDir, 'never-created')], cwd: tempDir }) },
  ],
};

/** The registered envelope verbs, as `PUBLISHED_SHAPES` names them. */
const REGISTERED_ENVELOPE_VERBS = PUBLISHED_SHAPES.flatMap((entry) => (entry.kind === 'report' ? entry.verbs : []));

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
  'claude marketplace validate': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
  'agent validate': { missing: 'USAGE_INVALID', unreadable: 'INPUT_UNREADABLE' },
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
  { verb: 'skill review', args: (path) => ['skill', 'review', path, '--yaml'] },
  { verb: 'claude marketplace validate', args: (path) => ['claude', 'marketplace', 'validate', path] },
  { verb: 'agent validate', args: (path) => ['agent', 'validate', path] },
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

/** A project declaring `guides`, holding one file, and `empty`, which no file matches. */
const COLLECTION_CONFIG = 'version: 1\nresources:\n  collections:\n    guides:\n      include:\n        - "docs/*.md"\n'
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
    cleanupTestTempDir(tempDir);
  });

  it('covers EXACTLY the registered envelope verbs — no more, no fewer', () => {
    expect(Object.keys(ENVELOPE_SCENARIOS).sort(byName)).toStrictEqual([...REGISTERED_ENVELOPE_VERBS].sort(byName));
  });

  it('gives every envelope verb one scenario per status the envelope can take', () => {
    for (const scenarios of Object.values(ENVELOPE_SCENARIOS)) {
        expect(scenarios.map((scenario) => scenario.status).sort(byName)).toStrictEqual([...REPORT_STATUSES].sort(byName));
    }
  });

  const cases = Object.entries(ENVELOPE_SCENARIOS).flatMap(([verb, scenarios]) =>
    scenarios.map((scenario) => ({ verb, ...scenario })),
  );

  it.each(cases)('$verb → $status ends on the code its document derives', (scenario) => {
    const { args, cwd } = scenario.run();
    const result = executeCli(binPath, args, { cwd });
    const document = documentOf(result.stdout);

    expect(document.status, `${result.stdout}\n${result.stderr}`).toBe(scenario.status);
    if (scenario.status === 'error') {
      expect(document['error'], `${result.stdout}\n${result.stderr}`).toMatchObject({ code: scenario.code });
    }
    // The gate is IN the document — the exit code derives from nothing else.
    expect(document.gate, `${result.stdout}\n${result.stderr}`).toStrictEqual({ strict: expect.any(Boolean) });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(exitCodeForReport(document));
  }, 60_000);

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
});
