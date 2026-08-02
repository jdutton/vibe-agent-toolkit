/**
 * `vat verify` / `vat validate` must REJECT a path argument, not discard it.
 *
 * The defect this pins (adopter finding B12): both commands declared no
 * positional argument and Commander 12 defaults `allowExcessArguments` to true,
 * so `vat verify dist/skills/demo` was accepted, the path was thrown away, a
 * whole-project config-driven run happened instead, and it reported
 * `status: success` with exit 0. An operator who believed they had scoped the
 * scan to one built bundle got an unscoped run AND a green tick — the green
 * tick on an unscoped run is the harmful half, because it is indistinguishable
 * from the scoped run that never happened.
 *
 * These are wiring tests on purpose: the pure helper cannot catch "someone
 * added a third orchestrator and forgot to call it", which is the only way this
 * regresses. They drive the real Command object built by the real factory.
 */

import type { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { createBuildTopLevelCommand } from '../../src/commands/build.js';
import { rejectPositionalArguments } from '../../src/commands/positional-args.js';
import { createValidateTopLevelCommand } from '../../src/commands/validate.js';
import { createVerifyTopLevelCommand } from '../../src/commands/verify.js';
import { captureProcessExit, type CapturedExit } from '../test-doubles.js';

/** The path an operator believes they are scoping the run to. */
const SCOPED_PATH = 'dist/skills/demo';

/** Parse `argv` through a real command, capturing stderr and the exit code. */
async function runCommand(command: Command, argv: string[]): Promise<CapturedExit> {
  return captureProcessExit(() => command.parseAsync(argv, { from: 'user' }));
}

describe('rejectPositionalArguments', () => {
  it('is a no-op when no operands were passed', () => {
    // The bare, correct invocation must not be disturbed.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`unexpected exit(${String(code)})`);
    }) as never);
    try {
      expect(() => rejectPositionalArguments([], 'vat verify', 'reads the config')).not.toThrow();
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe.each([
  { label: 'vat verify', factory: createVerifyTopLevelCommand },
  { label: 'vat validate', factory: createValidateTopLevelCommand },
  // `vat build` had the identical defect and is the worst of the three: the
  // other two only report against the wrong scope, this one WRITES against it.
  { label: 'vat build', factory: createBuildTopLevelCommand },
])('$label rejects a path argument', ({ label, factory }) => {
  it('exits 2 rather than running an unscoped whole-project scan', async () => {
    const { exited } = await runCommand(factory(), [SCOPED_PATH]);

    // 2, not 1: on both commands exit 1 is documented as "validation errors
    // found". A usage error reported as 1 tells a CI gate the artifacts are
    // broken when in fact nothing was inspected at all — the same class of
    // misdiagnosis as the silent success this replaces.
    expect(exited).toBe(2);
  });

  it('names the discarded argument, the command, and the path-taking alternative', async () => {
    const { stderr } = await runCommand(factory(), [SCOPED_PATH]);

    expect(stderr).toContain(SCOPED_PATH);
    expect(stderr).toContain(label);
    // What it actually operates on, so the reader learns why a path is meaningless here.
    expect(stderr).toContain('vibe-agent-toolkit.config.yaml');
    // The command that DOES take a path.
    expect(stderr).toContain('vat audit <path>');
  });

  it('reports every discarded argument, not just the first', async () => {
    const { stderr } = await runCommand(factory(), ['dist/skills/a', 'dist/skills/b']);

    expect(stderr).toContain('dist/skills/a');
    expect(stderr).toContain('dist/skills/b');
  });
});
