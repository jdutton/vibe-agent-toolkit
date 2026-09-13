/**
 * The exit-code contract, observed across verbs.
 *
 * ONE table: for each verb, a fixture that yields nothing at error severity,
 * one that yields a finding, and a usage mistake — and the code `$?` reads for
 * each is a member of `ExitCode`, the same member for every verb. This is the
 * cross-command pin that did not exist: five vocabularies coexisted (audit
 * exited 0 over `status: error`, skill review exited 1 on a warning, a bad
 * `--only` exited 1) and nothing asserted the contract as a whole.
 */

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createSuiteContext, executeCli, writeTestFile } from './test-common.js';

const ctx = createSuiteContext('vat-exit-codes-', import.meta.url);

/** A SKILL.md nothing complains about at error or warning severity. */
function cleanSkill(name: string): string {
  const description =
    'Reviews widgets for quality. Use when a reviewer wants a checklist walkthrough of a widget in depth.';
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nPurpose statement goes here.\n\nDoes one thing well.\n`;
}

/** A SKILL.md with an error-severity finding: a description past the 1024-character limit. */
function brokenSkill(name: string): string {
  const description = `Reviews widgets. ${'Use when a reviewer wants a walkthrough. '.repeat(30)}`;
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody.\n`;
}

/** A SKILL.md with a warning-severity finding only (a filler opener). */
function warnedSkill(name: string): string {
  const description =
    'This skill is used for when you need to review widgets for quality and completeness of the widget content.';
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody.\n`;
}

function skillDir(tempDir: string, name: string, content: string): string {
  const dir = safePath.join(tempDir, name);
  mkdirSyncReal(dir, { recursive: true });
  writeTestFile(safePath.join(dir, 'SKILL.md'), content);
  return dir;
}

/** A file no audit lane recognises. */
function plainFile(tempDir: string): string {
  const file = safePath.join(tempDir, 'notes.txt');
  writeTestFile(file, 'not a resource\n');
  return file;
}

/** A docs tree whose one link resolves (ok) or does not (a finding). */
function docsDir(tempDir: string, name: string, linkResolves: boolean): string {
  const dir = safePath.join(tempDir, name);
  mkdirSyncReal(dir, { recursive: true });
  writeTestFile(safePath.join(dir, 'a.md'), `# A\n\nSee [b](./${linkResolves ? 'b' : 'missing'}.md).\n`);
  writeTestFile(safePath.join(dir, 'b.md'), '# B\n');
  return dir;
}

interface Scenario {
  readonly verb: string;
  readonly outcome: 'ok' | 'findings' | 'usage' | 'error';
  readonly expected: number;
  readonly args: (tempDir: string) => string[];
}

const SCENARIOS: readonly Scenario[] = [
  { verb: 'resources validate', outcome: 'ok', expected: ExitCode.OK, args: (t) => ['resources', 'validate', docsDir(t, 'docs-ok', true)] },
  { verb: 'resources validate', outcome: 'findings', expected: ExitCode.FINDINGS, args: (t) => ['resources', 'validate', docsDir(t, 'docs-broken', false)] },
  { verb: 'resources validate', outcome: 'usage', expected: ExitCode.ERROR, args: (t) => ['resources', 'validate', docsDir(t, 'docs-usage', true), '--no-such-flag'] },
  { verb: 'resources validate', outcome: 'error', expected: ExitCode.ERROR, args: (t) => ['resources', 'validate', safePath.join(t, 'never-created')] },

  { verb: 'skill review', outcome: 'ok', expected: ExitCode.OK, args: (t) => ['skill', 'review', skillDir(t, 'clean', cleanSkill('clean'))] },
  { verb: 'skill review', outcome: 'findings', expected: ExitCode.FINDINGS, args: (t) => ['skill', 'review', skillDir(t, 'broken', brokenSkill('broken'))] },
  { verb: 'skill review', outcome: 'usage', expected: ExitCode.ERROR, args: (t) => ['skill', 'review', skillDir(t, 'usage', cleanSkill('usage')), '--no-such-flag'] },
  { verb: 'skill review', outcome: 'error', expected: ExitCode.ERROR, args: (t) => ['skill', 'review', safePath.join(t, 'never-created')] },

  { verb: 'audit', outcome: 'ok', expected: ExitCode.OK, args: (t) => ['audit', skillDir(t, 'audit-clean', cleanSkill('audit-clean'))] },
  { verb: 'audit', outcome: 'findings', expected: ExitCode.FINDINGS, args: (t) => ['audit', skillDir(t, 'audit-broken', brokenSkill('audit-broken'))] },
  { verb: 'audit', outcome: 'usage', expected: ExitCode.ERROR, args: (t) => ['audit', skillDir(t, 'audit-usage', cleanSkill('audit-usage')), '--no-such-flag'] },
  // A root that does not exist, or a file no lane recognises, is the INVOCATION's
  // mistake — it used to run anyway and publish `UNKNOWN_FORMAT` at exit 1.
  { verb: 'audit', outcome: 'error', expected: ExitCode.ERROR, args: (t) => ['audit', safePath.join(t, 'never-created')] },
  { verb: 'audit', outcome: 'error', expected: ExitCode.ERROR, args: (t) => ['audit', plainFile(t)] },

  { verb: 'validate', outcome: 'usage', expected: ExitCode.ERROR, args: () => ['validate', '--only', 'no-such-phase'] },
  // Outside any project the orchestrators threw before their own `try`; Node's
  // default for an unhandled rejection is exit 1 — the FINDINGS code.
  { verb: 'validate', outcome: 'error', expected: ExitCode.ERROR, args: () => ['validate'] },
  { verb: 'verify', outcome: 'error', expected: ExitCode.ERROR, args: () => ['verify'] },
  { verb: 'build', outcome: 'error', expected: ExitCode.ERROR, args: () => ['build'] },
  { verb: 'doctor', outcome: 'usage', expected: ExitCode.ERROR, args: () => ['doctor', '--no-such-flag'] },
  { verb: '(root)', outcome: 'usage', expected: ExitCode.ERROR, args: () => ['no-such-verb'] },
];

describe('the exit-code contract, across verbs (system test)', () => {
  beforeAll(ctx.setup);
  afterEach(ctx.cleanup);

  it.each(SCENARIOS)('$verb → $outcome exits $expected', async ({ args, expected, outcome }) => {
    const tempDir = ctx.createTempDir();
    const result = await executeCli(ctx.binPath, args(tempDir), { cwd: tempDir });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(expected);
    // An error ending is announced, not a bare code: the last-resort handler in
    // `bin.ts` writes the diagnostics, and every expected failure its message.
    if (outcome === 'error') expect(result.stderr.trim()).not.toBe('');
  });

  it('a warning alone is OK; --strict promotes it (skill review)', async () => {
    const tempDir = ctx.createTempDir();
    const dir = skillDir(tempDir, 'warned', warnedSkill('warned'));
    expect((await executeCli(ctx.binPath, ['skill', 'review', dir])).status).toBe(ExitCode.OK);
    expect((await executeCli(ctx.binPath, ['skill', 'review', dir, '--strict'])).status).toBe(ExitCode.FINDINGS);
  });

  it('every verb in the table uses only the three contract values', () => {
    const codes = new Set(SCENARIOS.map((s) => s.expected));
    expect([...codes].sort((a, b) => a - b)).toEqual([ExitCode.OK, ExitCode.FINDINGS, ExitCode.ERROR]);
  });
});
