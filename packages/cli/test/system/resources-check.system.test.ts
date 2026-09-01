/**
 * `vat resources check` end to end — the project's own SQL assertions, run as a
 * gate.
 *
 * The row-to-finding logic is unit tested in `resources` and needs no database.
 * What a spawn adds is everything around it: that a declared check reaches a real
 * projection, that a violation fails the run, and — the one this file exists for
 * — that a check which CANNOT RUN fails loudly instead of passing quietly.
 *
 * ## 🔑 And that a check with NOTHING TO RUN OVER fails the same way
 *
 * Every case in the first block below runs over the same two-file fixture, which
 * is guaranteed non-empty, so not one assertion in it could distinguish "no
 * violations" from "nothing to violate". That is the blindness that let a green
 * gate over an empty repository ship. The second block is a corpus emptied by
 * `.gitignore`, and it needs a tree of its own — the shared fixture must stay
 * populated for the cases above it to mean anything.
 */

import { spawnSync } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yaml from 'yaml';

import {
  cleanupTestTempDir,
  createTestTempDir,
  fs,
  getBinPath,
  safePath,
} from './test-common.js';
// The SYNCHRONOUS `executeCli` — `test-common.ts` exports an async one of the
// same name whose result has no `stdout` until awaited.
import { executeCli } from './test-helpers/index.js';

const binPath = getBinPath(import.meta.url);

let projectDir: string;

/** The statements the cases below reuse, and the descriptions that go with them. */
const MD_ROWS = "SELECT path FROM resource_realizations WHERE ext = '.md'";
const TXT_ROWS = "SELECT path FROM resource_realizations WHERE ext = '.txt'";
const NO_MARKDOWN = 'No markdown allowed';
const NO_TXT = 'No .txt files';
const BROKEN_DESC = 'This names a column that does not exist';
/** The config file every fixture writes, and the key the markdown check uses. */
const CONFIG_FILE = 'vibe-agent-toolkit.config.yaml';
const NO_MD_KEY = 'no-markdown';

/**
 * One `resources.checks` entry, indented for the `checks:` map.
 *
 * A helper rather than a hand-concatenated YAML string per case: six cases were
 * already spelling the same three indented lines out longhand, which is both a
 * duplication finding and the reason a seventh case is tedious enough to skip.
 */
function checkBlock(name: string, description: string, sql: string, severity = ''): string {
  return `    ${name}:\n      description: ${description}\n      sql: "${sql}"\n`
    + (severity === '' ? '' : `      severity: ${severity}\n`);
}

/** A `resources.validation.severity` block setting one code, for the `checks:` sibling. */
function severityOverride(code: string, level: string): string {
  return `  validation:\n    severity:\n      "${code}": ${level}\n`;
}

/**
 * Write the project's config with the given `resources.checks` block, and
 * optionally more of the `resources:` section (a `validation:` block, say).
 */
function writeChecksIn(root: string, checks: string, moreResources = ''): void {
  fs.writeFileSync(
    safePath.join(root, CONFIG_FILE),
    `version: 1\nresources:\n  checks:\n${checks}${moreResources}`,
    'utf-8',
  );
}

/** Write the populated fixture's config. */
function writeChecks(checks: string, moreResources = ''): void {
  writeChecksIn(projectDir, checks, moreResources);
}

/** What one spawn of the verb produced. */
interface CheckRun {
  status: number | null;
  doc: Record<string, unknown>;
  stderr: string;
}

/**
 * Run the verb in a given tree and parse its document.
 *
 * Takes the root rather than closing over one, because this file now drives TWO
 * fixtures — a populated one and one emptied by `.gitignore` — and a second copy
 * of the spawn-and-parse body is both a duplication finding and two places for
 * the parse to drift.
 */
function checkIn(cwd: string, ...args: string[]): CheckRun {
  const result = executeCli(binPath, ['resources', 'check', ...args], { cwd });
  return {
    status: result.status,
    doc: (yaml.parse(result.stdout) ?? {}) as Record<string, unknown>,
    stderr: result.stderr,
  };
}

/** Run the verb in the populated fixture. */
function check(...args: string[]): CheckRun {
  return checkIn(projectDir, ...args);
}

/** One finding, as these cases read it back off the document. */
interface CheckFinding {
  code: string;
  message: string;
  severity: string;
}

/**
 * Run `check` and assert it FAILED under the non-overridable run-integrity code,
 * returning the finding so each case can assert what is specific to it.
 *
 * 🔑 Shared deliberately, not merely to avoid repetition: two cases assert this
 * same shape — a broken statement, and a broken statement whose config tried to
 * `ignore` it — and the property under test is precisely that those two agree.
 * One helper means a regression cannot fix one spelling and miss the other.
 */
function expectRunIntegrityFailure(...args: string[]): CheckFinding {
  const { status, doc } = check(...args);

  expect(status).toBe(1);
  expect(doc['status']).toBe('error');
  const [issue] = doc['issues'] as CheckFinding[];
  expect(issue?.code).toBe('RESOURCE_CHECK_BROKEN');

  return issue as CheckFinding;
}

describe('vat resources check', () => {
  beforeAll(() => {
    projectDir = createTestTempDir('vat-resources-check-');
    fs.mkdirSync(safePath.join(projectDir, 'docs'), { recursive: true });
    fs.writeFileSync(safePath.join(projectDir, 'docs/a.md'), '# Alpha\n', 'utf-8');
    fs.writeFileSync(safePath.join(projectDir, 'docs/b.md'), '# Bravo\n', 'utf-8');
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- fixture setup
    spawnSync('git', ['init', '--quiet'], { cwd: projectDir });
  });

  afterAll(() => {
    cleanupTestTempDir(projectDir);
  });

  it('passes with no findings when the statement selects nothing', () => {
    // The contract: the statement selects the VIOLATIONS, so selecting nothing
    // IS the pass. `checksRun` is what stops this reading as a vacuous green —
    // without it, "one check passed" and "no check ran" are the same document.
    writeChecks(checkBlock('no-txt', NO_TXT, TXT_ROWS));

    const { status, doc } = check();

    expect(status).toBe(0);
    expect(doc['status']).toBe('success');
    expect(doc['checksRun']).toBe(1);
    expect(doc['issues']).toStrictEqual([]);
    // 🔑 The other denominator, and the half a pure test cannot reach: that the
    // number published came off a REAL population rather than a plausible
    // constant. The fixture has two markdown files, so a truthful measure is
    // above zero here — and it is what makes the empty-corpus block below a
    // contrast rather than an assertion about nothing.
    expect(doc['membersEnumerated']).toBeGreaterThan(0);
  });

  it('fails the run and names the file when a check is violated', () => {
    writeChecks(checkBlock(NO_MD_KEY, NO_MARKDOWN, `${MD_ROWS} ORDER BY path`));

    const { status, doc } = check();

    expect(status).toBe(1);
    expect(doc['status']).toBe('error');
    const issues = doc['issues'] as { code: string; severity: string; path?: string }[];
    expect(issues.length).toBeGreaterThanOrEqual(2);
    expect(issues[0]?.code).toBe('CUSTOM:no-markdown');
    expect(issues[0]?.severity).toBe('error');
    // The `path` column anchored the finding to a file a reader can open.
    expect(issues.map((i) => i.path)).toContain('docs/a.md');
  });

  it('honours a declared warning severity without failing the run', () => {
    writeChecks(checkBlock('soft', 'Prefer no markdown', MD_ROWS, 'warning'));

    const { status, doc } = check();

    expect(status).toBe(0);
    expect(doc['status']).toBe('warning');
    expect((doc['issueCounts'] as { errors: number }).errors).toBe(0);
  });

  it('FAILS a check whose SQL will not run, rather than skipping it', () => {
    // 🔑 The property this verb lives or dies on. VAT ships no schema version, so
    // a renamed column simply breaks a check. Logging and carrying on would make
    // a check that stopped running indistinguishable from one that passed, and
    // the project would report green over an assertion nobody is making.
    writeChecks(checkBlock('broken', BROKEN_DESC, 'SELECT contentHash FROM blobs'));

    // 🔑 The helper pins its OWN code, not `CUSTOM:broken`. Sharing the check's
    // code meant one documented config line — `severity: { 'CUSTOM:broken':
    // ignore }` — silenced both "this check found a violation" and "this check
    // stopped running". See the case below.
    const issue = expectRunIntegrityFailure();

    expect(issue.message).toContain('broken');
    expect(issue.message).toContain('could not run');
    // And it says what the projection actually has, which is the only way to
    // find out what the column became.
    expect(issue.message).toContain('contentKey');
  });

  it('runs only the named check under --check', () => {
    writeChecks(
      checkBlock('first', NO_MARKDOWN, MD_ROWS)
      + checkBlock('second', NO_TXT, TXT_ROWS),
    );

    const { doc } = check('--check', 'second');

    expect(doc['checksRun']).toBe(1);
    expect(doc['issues']).toStrictEqual([]);
  });

  it('runs BOTH checks in one invocation and reports both sets of findings', () => {
    // The case the suite did not have. Every other spawned case declares one
    // check — `--check second` declares two and filters to one, which the loop
    // cannot tell apart — so `checksRun` was never observed above 1 and a `break`
    // at the end of the loop would have left the whole file green.
    writeChecks(
      checkBlock(NO_MD_KEY, NO_MARKDOWN, `${MD_ROWS} ORDER BY path`)
      + checkBlock('no-headings', 'No headings allowed', `${MD_ROWS} ORDER BY path DESC`),
    );

    const { status, doc } = check();

    expect(status).toBe(1);
    expect(doc['checksRun']).toBe(2);
    const codes = new Set((doc['issues'] as { code: string }[]).map((i) => i.code));
    expect([...codes].sort((a, b) => a.localeCompare(b)))
      .toStrictEqual(['CUSTOM:no-headings', 'CUSTOM:no-markdown']);
  });

  it('accepts the documented CUSTOM: severity override instead of refusing the config', () => {
    // 🔑 Defect 1 end to end, and the reason it was the worst of the three. This
    // config is exactly what `--help`, the `resources.checks` schema description
    // and `sql-checks.ts` all prescribe. The severity key schema was the closed
    // registry enum, so Zod rejected `CUSTOM:soft` as an invalid enum value —
    // which failed `ProjectConfigSchema`, which failed `loadConfig`, which every
    // command calls. Following our own documentation exited 2 with a dump of the
    // whole ~150-entry registry, on `vat resources scan` as readily as here.
    writeChecks(
      checkBlock('soft', NO_MARKDOWN, MD_ROWS),
      severityOverride('CUSTOM:soft', 'ignore'),
    );

    const { status, doc, stderr } = check();

    expect(stderr).not.toContain('invalid_enum_value');
    expect(status).toBe(0);
    // Ignored means EXECUTED and then dropped, never "not run": `checksRun` is
    // what makes those two distinguishable.
    expect(doc['checksRun']).toBe(1);
    expect(doc['issues']).toStrictEqual([]);
  });

  it('a check set to `ignore` STILL fails the run when its SQL is broken', () => {
    // 🔑 The property the whole verb rests on, under the config that used to
    // dissolve it. `ignore` is about violations of the check; it must not silence
    // the news that the check asserted nothing. Sharing `CUSTOM:broken` between
    // the two made a renamed projection column exit 0.
    writeChecks(
      checkBlock('broken', BROKEN_DESC, 'SELECT contentHash FROM blobs'),
      severityOverride('CUSTOM:broken', 'ignore'),
    );

    const issue = expectRunIntegrityFailure();

    expect(issue.severity).toBe('error');
  });

  it('refuses an unknown --check name instead of reporting a silent green', () => {
    // 🔑 `--check orphan-skills` is the example in this command's own help text.
    // Nothing compared the flag against the declared keys, so an unknown name
    // filtered every check away and exited 0 with `checksRun: 0`, `issues: []`
    // and empty stderr — a CI step that passes forever while asserting nothing.
    writeChecks(checkBlock('declared-one', NO_TXT, TXT_ROWS));

    const { status, doc } = check('--check', 'declared-none');

    // 2, not 1: a mistyped flag is an operator error, not a content violation.
    expect(status).toBe(2);
    expect(doc['status']).toBe('error');
    // The typo AND the valid set, so the operator does not go read the config.
    expect(doc['error']).toContain('declared-none');
    expect(doc['error']).toContain('declared-one');
  });

  it('says so loudly when the project declares no checks at all', () => {
    // Exit 0 — declaring none is legitimate — but a silent passing report would
    // let a misspelled config key read as a green gate forever.
    fs.writeFileSync(
      safePath.join(projectDir, CONFIG_FILE),
      'version: 1\nresources:\n  include:\n    - "**/*.md"\n',
      'utf-8',
    );

    const { status, doc, stderr } = check();

    expect(status).toBe(0);
    expect(doc['checksRun']).toBe(0);
    expect(stderr).toContain('No checks are declared');
  });
});

/**
 * The reviewer's reproduction, as a test.
 *
 * A scratch repository with `.gitignore = *` and two declared checks reported
 * `checksRun: 2`, `status: success`, exit 0 and empty stderr over a corpus of
 * ZERO files: the rule reported nothing because there was nothing to report on.
 * `checksRun` is the denominator of RULES, so a gate over eight thousand files
 * and a gate over none serialized identically, and anything that empties the
 * enumeration — a broad ignore, a shallow or sparse CI checkout, a root that
 * resolved elsewhere — turned the whole gate green.
 *
 * It gets its own tree because the point is a corpus that IS empty, which the
 * fixture above must never be.
 */
describe('vat resources check over an emptied corpus', () => {
  let emptyDir: string;

  beforeAll(() => {
    emptyDir = createTestTempDir('vat-resources-check-empty-');
    fs.mkdirSync(safePath.join(emptyDir, 'docs'), { recursive: true });
    fs.writeFileSync(safePath.join(emptyDir, 'docs/a.md'), '# Alpha\n', 'utf-8');
    fs.writeFileSync(safePath.join(emptyDir, 'docs/b.md'), '# Bravo\n', 'utf-8');
    // 🔑 The whole fixture. One pattern, and the enumeration declines every
    // member — a real, ordinary thing to find in a repository or a CI image.
    fs.writeFileSync(safePath.join(emptyDir, '.gitignore'), '*\n', 'utf-8');
    // A git repository, because the ignore oracle is `gitTrackerForProjectRoot`
    // and without one `.gitignore` is just a file.
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- fixture setup
    spawnSync('git', ['init', '--quiet'], { cwd: emptyDir });
    writeChecksIn(
      emptyDir,
      checkBlock(NO_MD_KEY, NO_MARKDOWN, MD_ROWS) + checkBlock('no-txt', NO_TXT, TXT_ROWS),
    );
  });

  afterAll(() => {
    cleanupTestTempDir(emptyDir);
  });

  it('does NOT report success when every declared check ran over nothing', () => {
    // 🔑 The reproduced defect, stated as the assertion whose absence let it
    // ship. Both checks ran; neither could have found anything; the old code
    // called that a pass.
    const { status, doc } = checkIn(emptyDir);

    expect(doc['membersEnumerated']).toBe(0);
    expect(doc['checksRun']).toBe(2);
    expect(doc['status']).not.toBe('success');
    expect(status).not.toBe(0);
  });

  it('reports it under the non-overridable run-integrity code, at error', () => {
    const { doc } = checkIn(emptyDir);

    const issues = doc['issues'] as { code: string; severity: string; message: string }[];
    expect(issues[0]?.code).toBe('RESOURCE_CHECK_BROKEN');
    expect(issues[0]?.severity).toBe('error');
    // Actionable, not merely true: the count, the consequence, and the first
    // place to look. "Empty population" would leave the operator nowhere.
    expect(issues[0]?.message).toContain('0 members');
    expect(issues[0]?.message).toContain('.gitignore');
  });
});
