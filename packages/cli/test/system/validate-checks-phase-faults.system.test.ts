/**
 * The checks phase with a FAULTY child, and with a child rooted somewhere other than where it runs.
 *
 * Each fault is injected into the child alone by a test-only preload (see
 * `test-helpers/checks-phase.ts`): it exits before publishing, garbles its stdout, exits against its
 * own report, or refuses a config only it reads. The nested-project cases pin the root operand the
 * supervisor hands the child.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

import { cleanupTestTempDir, fs, safePath } from './test-common.js';
import {
  checkNames,
  checksPhase,
  MD_ROWS,
  preload,
  RUN_INTEGRITY,
  TXT_ROWS,
  vat,
  writeConfig,
} from './test-helpers/checks-phase.js';
import { createMarkdownGitFixture } from './test-helpers/index.js';

// ⛔ Disposal paths: every `vat` process (and its checks child) inherits the scratch TMPDIR.
const scratch = useScratchTmpdir('vat-scratch-validate-checks-faults-');

let projectDir: string;

describe('vat validate — the checks phase, a faulty child', () => {
  beforeAll(() => {
    projectDir = createMarkdownGitFixture('vat-validate-checks-faults-');
  });

  afterAll(() => {
    cleanupTestTempDir(projectDir);
  });

  it('a child that publishes nothing before population is a phase error (exit 2)', () => {
    writeConfig(projectDir, [['quick', TXT_ROWS]]);

    const run = vat(projectDir, ['validate'], { NODE_OPTIONS: preload('child-only-exit-at-start.mjs') });

    expect(run.status).toBe(2);
    expect(run.error?.code).toBe('RUN_INCOMPLETE');
    const phase = checksPhase(run);
    expect(phase.status).toBe('error');
    // ITS ending, not any other way to reach RUN_INCOMPLETE: a child that exited 0 having written
    // nothing, before it had even reported starting.
    expect(phase.error?.message).toContain('the child process exited 0 and published no report at all');
    expect(phase.error?.message).toContain('before the child process had finished starting');
  });

  it('garbled stdout after population is RESOURCE_CHECK_BROKEN naming the unreadable report (exit 1)', () => {
    writeConfig(projectDir, [['quick', TXT_ROWS]]);

    const run = vat(projectDir, ['validate'], { NODE_OPTIONS: preload('child-only-garbled-stdout.mjs') });

    expect(run.status).toBe(1);
    expect(checksPhase(run).status).toBe('findings');
    const broken = run.findings.filter((f) => f.code === RUN_INTEGRITY);
    expect(broken).toHaveLength(1);
    expect(broken[0]?.message).toContain('is not this command\'s document');
  });

  it('a child whose exit contradicts its clean report fails the phase (RESOURCE_CHECK_BROKEN, exit 1)', () => {
    writeConfig(projectDir, [['quick', TXT_ROWS]]);

    const run = vat(projectDir, ['validate'], { NODE_OPTIONS: preload('child-only-exit-disagrees.mjs') });

    expect(run.status, run.stderr).toBe(1);
    expect(checksPhase(run).status).toBe('findings');
    const broken = run.findings.filter((f) => f.code === RUN_INTEGRITY);
    expect(broken).toHaveLength(1);
    expect(broken[0]?.message).toContain('verdict is exit 0, and then exited 3');
  });

  it('standalone, the same contradiction is not forwarded as a pass (exit 1)', () => {
    writeConfig(projectDir, [['quick', TXT_ROWS]]);

    const run = vat(projectDir, ['resources', 'check'], { NODE_OPTIONS: preload('child-only-exit-disagrees.mjs') });

    expect(run.status, run.stderr).toBe(1);
    expect(run.findings.some((f) => f.code === RUN_INTEGRITY && f.message.includes('exited 3'))).toBe(true);
  });

  /**
   * The exit table's "the child published a refusal before populating" row: the phase is an error
   * carrying the CHILD's code, and the run is RUN_INCOMPLETE (2). Never a pass and never a finding —
   * a child that refused its config checked nothing.
   *
   * 🔑 It is also where `vat validate --debug` is observed reaching the CHILD: under `--debug` a
   * refusal prints the stack of its throw site, and the frame naming `runChecksHere` exists only in
   * the child — the parent never runs the checks. Without `--debug` the child prints no stack.
   */
  it.each([false, true])('a child that refuses its own config is a phase error carrying its code (exit 2; --debug=%s)', (debug) => {
    writeConfig(projectDir, [['quick', TXT_ROWS]]);
    const broken = safePath.join(scratch(), 'child.config.yaml');
    fs.writeFileSync(broken, 'resources: [unterminated\n', 'utf-8');

    const run = vat(projectDir, debug ? ['validate', '--debug'] : ['validate'], {
      NODE_OPTIONS: preload('child-only-config.mjs'),
      TEST_CHILD_ONLY_CONFIG: broken,
    });

    expect(run.stderr.includes(' at runChecksHere ('), run.stderr).toBe(debug);

    expect(run.status, run.stderr).toBe(2);
    expect(run.error?.code).toBe('RUN_INCOMPLETE');
    expect(checksPhase(run).status).toBe('error');
    expect(checksPhase(run).error?.code).toBe('CONFIG_INVALID');
    // The resources phase, which the parent ran over the project's own config, still finished.
    expect(run.phases.find((phase) => phase.name === 'resources')?.status).toBe('ok');
  });
});

describe('vat validate and vat resources check — a nested project', () => {
  let outer: string;
  let inner: string;

  beforeAll(() => {
    outer = createMarkdownGitFixture('vat-validate-checks-nested-');
    writeConfig(outer, [['outer-check', MD_ROWS, 'warning']]);
    inner = safePath.join(outer, 'inner');
    fs.mkdirSync(safePath.join(inner, 'docs'), { recursive: true });
    fs.writeFileSync(safePath.join(inner, 'docs', 'c.md'), '# Charlie\n', 'utf-8');
    writeConfig(inner, [['inner-check', MD_ROWS, 'warning']]);
  });

  afterAll(() => {
    cleanupTestTempDir(outer);
  });

  /**
   * ⚠️ This does NOT pin the child's root operand: run from inside the inner project, the child
   * inherits that working directory and would resolve the same root without being told. The case
   * below, which names the inner project from the outer root, is the one that can tell.
   */
  it('vat validate run inside the inner project checks it, and only it', () => {
    const run = vat(inner, ['validate']);

    expect(run.status, run.stderr).toBe(0);
    const ran = checkNames(checksPhase(run).data);
    expect(ran).toContain('inner-check');
    expect(ran).not.toContain('outer-check');
    expect(run.findings.filter((f) => f.code === 'CUSTOM:inner-check').length).toBeGreaterThan(0);
  });

  /**
   * 🔑 The case that can tell the operand apart: the supervising process resolves `inner` from
   * the operand while the child inherits the OUTER working directory. A child spawned without the
   * resolved root would check the outer project and report it as the inner one.
   */
  it('vat resources check <inner>, run from the outer root, checks the inner project', () => {
    const run = vat(outer, ['resources', 'check', 'inner']);

    expect(run.status, run.stderr).toBe(0);
    const ran = checkNames(run.data);
    expect(ran).toContain('inner-check');
    expect(ran).not.toContain('outer-check');
  });
});
