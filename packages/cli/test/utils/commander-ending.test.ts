import { ExitCode } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';

import { exitCodeForCommanderEnding } from '../../src/utils/commander-ending.js';

describe('exitCodeForCommanderEnding', () => {
  // Commander reports a SUCCESSFUL termination through the same error channel
  // as a failing one: `--help` and `--version` both end via `_exit(0, …)`.
  // Remapping those would turn every help page into a failing CI step.
  it('leaves a successful commander ending at 0', () => {
    expect(exitCodeForCommanderEnding(0)).toBe(0);
  });

  // The regression this whole mapping exists for. Commander's default for an
  // unknown option is exit 1 — which every command's `--help` publishes as
  // "at least one error-severity finding". `vat resources check --json` (the
  // option is `--format json`) therefore claimed a check had been violated
  // when nothing had run.
  it('remaps commander default 1 to ERROR, so a usage mistake is not read as a finding', () => {
    expect(exitCodeForCommanderEnding(1)).toBe(ExitCode.ERROR);
    expect(exitCodeForCommanderEnding(1)).not.toBe(ExitCode.FINDINGS);
  });

  // An unknown COMMAND arrives as code `commander.help` with a non-zero exit,
  // because the `command:*` handler renders help with `{ error: true }`. Any
  // non-zero ending is a usage mistake regardless of the code string, which is
  // why the exit code is the discriminator and the string is not.
  it('treats every non-zero commander ending as a usage mistake', () => {
    for (const code of [1, 2, 3, 64, 127]) {
      expect(exitCodeForCommanderEnding(code)).toBe(ExitCode.ERROR);
    }
  });
});
