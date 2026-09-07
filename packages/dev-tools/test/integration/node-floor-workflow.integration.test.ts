/* eslint-disable security/detect-non-literal-fs-filename -- test file: every path is this suite's own mkdtemp scratch dir or a path derived from this file's location */

/**
 * Executes the shell in `.github/workflows/node-floor.yml` instead of reading it.
 *
 * Two defects lived in that file and both were invisible to any assertion about
 * its text:
 *
 * 1. **Script injection.** `${{ steps.floor.outputs.version }}` was interpolated
 *    textually into a `run:` block, and its content is the PR's own
 *    `package.json` `engines.node`. Rendering the verbatim step body with
 *    `"node": ">=22.13.0\"; echo INJECTED; id -un; : \""` and running it under
 *    `bash -e` executed the injected commands. The blast radius was bounded —
 *    `pull_request`, not `pull_request_target`, so no secrets and a read-only
 *    token — but a fork PR choosing the shell a workflow runs is not a shape to
 *    leave standing.
 *
 * 2. **A blaming error message.** The runner assertion compares
 *    `process.versions.node` for exact string equality against whatever the
 *    declared range strips to. `>=22` strips to `22`; setup-node then installs
 *    `22.<latest>` and the comparison fails, reporting "this job would have
 *    tested the wrong runtime" — blaming the runner for a legal floor the DERIVE
 *    step should have refused. Fail-closed, so never a hole; wrong-fingered, so
 *    always a wasted investigation.
 *
 * Both are properties of the script, so the tests run the script. An assertion
 * on the YAML's text would have passed against a rewrite that reintroduced
 * either one under a different spelling.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { safeExecResult } from '@vibe-agent-toolkit/utils/process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { createTestTempDir, cleanupTestTempDir } from '../test-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = safePath.join(__dirname, '../../../../.github/workflows/node-floor.yml');

/** The expression whose textual interpolation into a `run:` block is the defect. */
const FLOOR_EXPRESSION = 'steps.floor.outputs.version';

/** Name fragments identifying the two steps under test. */
const ASSERT_STEP = 'Assert the runner';
const DERIVE_STEP = 'Derive the declared Node floor';

interface WorkflowStep {
  name?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}

interface Workflow {
  jobs: Record<string, { steps: WorkflowStep[] }>;
}

function loadSteps(): WorkflowStep[] {
  const workflow = parseYaml(readFileSync(WORKFLOW_PATH, 'utf8')) as Workflow;
  return Object.values(workflow.jobs).flatMap((job) => job.steps);
}

function stepNamed(fragment: string): WorkflowStep {
  const step = loadSteps().find((candidate) => candidate.name?.includes(fragment));
  if (step === undefined) {
    throw new Error(`No step in node-floor.yml has a name containing ${JSON.stringify(fragment)}`);
  }
  return step;
}

/**
 * Run a step's `run:` script the way the runner would, under `bash -e`.
 *
 * `floorValue` is applied TWICE, deliberately, because that is how the runner
 * behaves and the difference is the defect: any `${{ steps.floor.outputs.version }}`
 * left in the script is substituted as TEXT before bash ever sees it, while a
 * value carried in `env:` arrives as a shell variable. Feeding the same hostile
 * string through both routes is what makes this a reproduction rather than an
 * assertion about spelling.
 *
 * @param step - The parsed workflow step
 * @param options - Working directory, the derived floor, and extra env
 * @returns The combined output and exit status
 */
function runStep(
  step: WorkflowStep,
  options: { cwd: string; floorValue?: string; env?: Record<string, string> },
): { status: number; output: string } {
  if (step.run === undefined) throw new Error(`Step ${step.name ?? '<unnamed>'} has no run: script`);

  const floorValue = options.floorValue ?? '';
  const script = step.run.replaceAll(/\$\{\{\s*steps\.floor\.outputs\.version\s*\}\}/g, floorValue);

  // Whatever the step declares in `env:` that references the derived floor gets
  // that value, the way the runner would resolve it.
  const declaredEnv = Object.fromEntries(
    Object.entries(step.env ?? {}).map(([key, value]) => [
      key,
      value.includes(FLOOR_EXPRESSION) ? floorValue : value,
    ]),
  );

  const result = safeExecResult('bash', ['-e', '-c', script], {
    cwd: options.cwd,
    env: { PATH: process.env['PATH'] ?? '', ...declaredEnv, ...options.env },
  });

  return {
    status: result.status,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

/**
 * The shell metacharacter payload a fork PR could put in `engines.node`.
 *
 * The marker is ARITHMETIC on purpose. A payload whose literal text is also its
 * output cannot distinguish "the shell ran this" from "something echoed the
 * value"; `$((6*7))` prints `42` only when bash evaluates it, and bash does not
 * re-expand the contents of a variable, so {@link EXECUTED_MARKER} appears in the
 * output if and only if the payload was executed.
 */
const INJECTION = '>=22.13.0"; echo "INJECTED-COMMAND-RAN-$((6*7))"; : "';

/** Present in the output only if {@link INJECTION} was executed as shell. */
const EXECUTED_MARKER = 'INJECTED-COMMAND-RAN-42';

/**
 * The OTHER injection, which {@link INJECTION} cannot reach: it contains no
 * newline, and a newline is the whole mechanism here.
 *
 * The refusal path echoes the PR's own `engines.node` verbatim into a
 * `::error::` line. A runner reads its stdout LINE BY LINE and treats any line
 * beginning `::` as a workflow command, so a value carrying newlines does not
 * merely appear in an error message — its later lines ARE workflow commands.
 * Executed against the unfixed step, this payload reached the runner as a real
 * `::add-mask::` and a real, attacker-authored `::error::`.
 *
 * Not code execution — the derive regex is fail-closed, so no bad floor escapes.
 * It is log and annotation forgery: masking output the maintainer needs to read,
 * and posting an arbitrary error annotation on the PR under CI's name.
 */
const NEWLINE_INJECTION = '>=22.13\n::add-mask::supersecret\n::error::attacker-controlled';

/** Workflow-command fragments that must never survive into the step's output. */
const FORGED_COMMANDS = ['::add-mask::', 'attacker-controlled'];

describe.skipIf(process.platform === 'win32')('node-floor.yml', () => {
  let tempDir: string;
  let githubOutput: string;

  beforeEach(() => {
    tempDir = createTestTempDir({ prefix: 'node-floor-workflow-' });
    mkdirSyncReal(tempDir, { recursive: true });
    githubOutput = safePath.join(tempDir, 'github-output');
  });

  afterEach(() => {
    cleanupTestTempDir(tempDir);
  });

  function derive(engineNode: string): { status: number; output: string; derived: string } {
    writeFileSync(
      safePath.join(tempDir, 'package.json'),
      JSON.stringify({ engines: { node: engineNode } }),
    );
    const result = runStep(stepNamed(DERIVE_STEP), {
      cwd: tempDir,
      env: { GITHUB_OUTPUT: githubOutput },
    });

    // Absent means the step wrote no output at all, which is one of the things
    // under test — not a failure to read.
    const derived = existsSync(githubOutput) ? readFileSync(githubOutput, 'utf8') : '';
    return { ...result, derived };
  }

  describe('no run: script is assembled from `${{ }}` interpolation', () => {
    it('holds for every step, so no PR-controlled value is ever shell source text', () => {
      const offenders = loadSteps()
        .filter((step) => step.run?.includes('${{') === true)
        .map((step) => step.name ?? '<unnamed>');

      // A value reaching a script through `env:` is a shell VARIABLE, quoted at
      // the point of use. Interpolated, it is shell SOURCE, and `engines.node`
      // comes from the pull request.
      expect(offenders).toEqual([]);
    });

    it('passes the derived floor to the assertion through env:, not through the script', () => {
      const assertion = stepNamed(ASSERT_STEP);

      expect(Object.values(assertion.env ?? {}).join(' ')).toContain(FLOOR_EXPRESSION);
      expect(assertion.run).toContain('"$FLOOR"');
    });
  });

  describe('the runner assertion', () => {
    it('does NOT execute a shell payload smuggled in through the floor value', () => {
      const assertion = runStep(stepNamed(ASSERT_STEP), {
        cwd: tempDir,
        floorValue: INJECTION,
      });

      expect(assertion.output).not.toContain(EXECUTED_MARKER);
      // And it still refuses, because the runner plainly is not that string.
      expect(assertion.status).not.toBe(0);
    });

    it('passes when the runner really is at the floor', () => {
      const assertion = runStep(stepNamed(ASSERT_STEP), {
        cwd: tempDir,
        floorValue: process.versions.node,
      });

      expect(assertion.status).toBe(0);
    });
  });

  describe('the derive step', () => {
    it('derives a full version from an ordinary floor', () => {
      const { status, derived } = derive('>=22.13.0');

      expect(status).toBe(0);
      expect(derived).toContain('version=22.13.0');
    });

    it.each([
      ['>=22', 'a major with no minor or patch'],
      ['22.x', 'an x-range'],
      ['>=22.13.0 <25', 'a compound range'],
      ['>=22.13', 'a major.minor'],
    ])('refuses %s (%s) AT THE DERIVE STEP, where the message can be accurate', (range) => {
      const { status, output, derived } = derive(range);

      expect(status).not.toBe(0);
      // The reader must be sent to the manifest, not to the runner.
      expect(output).toContain(range);
      expect(output).not.toContain('would have tested the wrong runtime');
      expect(derived).not.toContain('version=');
    });

    it('refuses a shell payload rather than deriving anything from it', () => {
      const { status, output, derived } = derive(INJECTION);

      expect(output).not.toContain(EXECUTED_MARKER);
      expect(status).not.toBe(0);
      expect(derived).not.toContain('version=');
    });

    it('does not let the REFUSAL message carry workflow commands out of the value', () => {
      const { status, output, derived } = derive(NEWLINE_INJECTION);

      // Still fail-closed on the floor itself.
      expect(status).not.toBe(0);
      expect(derived).not.toContain('version=');

      // And the refusal names the value without republishing its later lines.
      for (const forged of FORGED_COMMANDS) {
        expect(output).not.toContain(forged);
      }
      // Not vacuous: the message still tells the reader what it refused.
      expect(output).toContain('22.13');
    });
  });
});
