/**
 * `vat resources check` end to end — the project's own SQL assertions, run as a
 * gate.
 *
 * The row-to-finding logic is unit tested in `resources` and needs no database.
 * What a spawn adds is everything around it: that a declared check reaches a real
 * projection, that a violation fails the run, and — the one this file exists for
 * — that a check which CANNOT RUN fails loudly instead of passing quietly.
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

/** Write the project's config with the given `resources.checks` block. */
function writeChecks(checks: string): void {
  fs.writeFileSync(
    safePath.join(projectDir, 'vibe-agent-toolkit.config.yaml'),
    `version: 1\nresources:\n  checks:\n${checks}`,
    'utf-8',
  );
}

/** Run the verb and parse its document. */
function check(...args: string[]): { status: number | null; doc: Record<string, unknown>; stderr: string } {
  const result = executeCli(binPath, ['resources', 'check', ...args], { cwd: projectDir });
  return {
    status: result.status,
    doc: (yaml.parse(result.stdout) ?? {}) as Record<string, unknown>,
    stderr: result.stderr,
  };
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
    writeChecks(
      "    no-txt:\n"
      + "      description: No .txt files\n"
      + "      sql: \"SELECT path FROM resource_realizations WHERE ext = '.txt'\"\n",
    );

    const { status, doc } = check();

    expect(status).toBe(0);
    expect(doc['status']).toBe('success');
    expect(doc['checksRun']).toBe(1);
    expect(doc['issues']).toStrictEqual([]);
  });

  it('fails the run and names the file when a check is violated', () => {
    writeChecks(
      "    no-markdown:\n"
      + "      description: No markdown allowed\n"
      + "      sql: \"SELECT path FROM resource_realizations WHERE ext = '.md' ORDER BY path\"\n",
    );

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
    writeChecks(
      "    soft:\n"
      + "      description: Prefer no markdown\n"
      + "      sql: \"SELECT path FROM resource_realizations WHERE ext = '.md'\"\n"
      + "      severity: warning\n",
    );

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
    writeChecks(
      "    broken:\n"
      + "      description: This names a column that does not exist\n"
      + "      sql: \"SELECT contentHash FROM blobs\"\n",
    );

    const { status, doc } = check();

    expect(status).toBe(1);
    expect(doc['status']).toBe('error');
    const [issue] = doc['issues'] as { code: string; message: string }[];
    expect(issue?.code).toBe('CUSTOM:broken');
    expect(issue?.message).toContain('could not run');
    // And it says what the projection actually has, which is the only way to
    // find out what the column became.
    expect(issue?.message).toContain('contentKey');
  });

  it('runs only the named check under --check', () => {
    writeChecks(
      "    first:\n"
      + "      description: No markdown allowed\n"
      + "      sql: \"SELECT path FROM resource_realizations WHERE ext = '.md'\"\n"
      + "    second:\n"
      + "      description: No .txt files\n"
      + "      sql: \"SELECT path FROM resource_realizations WHERE ext = '.txt'\"\n",
    );

    const { doc } = check('--check', 'second');

    expect(doc['checksRun']).toBe(1);
    expect(doc['issues']).toStrictEqual([]);
  });

  it('says so loudly when the project declares no checks at all', () => {
    // Exit 0 — declaring none is legitimate — but a silent passing report would
    // let a misspelled config key read as a green gate forever.
    fs.writeFileSync(
      safePath.join(projectDir, 'vibe-agent-toolkit.config.yaml'),
      'version: 1\nresources:\n  include:\n    - "**/*.md"\n',
      'utf-8',
    );

    const { status, doc, stderr } = check();

    expect(status).toBe(0);
    expect(doc['checksRun']).toBe(0);
    expect(stderr).toContain('No checks are declared');
  });
});
