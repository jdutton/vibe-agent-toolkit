/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */

/**
 * Integration test: an UNLOADABLE governing config degrades the scan, it does
 * not destroy it.
 *
 * 🚨 This file exists because `vat audit`'s two skill-validation lanes carried
 * two different policies for the same input. `validateSingleSkill` wrapped the
 * config resolution in a try/catch whose comment reads "audit is a bulk linter
 * … rather than aborting the scan" — while sitting on the lane that does no
 * bulk scanning. `handleFileEntry`, the lane the directory scan and `--user`
 * actually reach (677 of 851 skills on a real `--user` run), called the same
 * resolver unguarded.
 *
 * So one typo in one nested `vibe-agent-toolkit.config.yaml` aborted the WHOLE
 * tree — exit 2, zero skills audited, no findings at all — while pointing the
 * same command at the same SKILL.md under that same config exited 0 and
 * reported it as passing. Same tree, same skill, two verdicts, decided only by
 * whether the argument was a file or its parent directory.
 *
 * The policy these tests pin is the one `SCAN_PATH_UNREADABLE` was written to
 * enforce and states in its own docstring: degrading beats destroying, and
 * silence is not the alternative. A scan that quietly skipped the config would
 * be the same failure shape as a detector that silently disables itself, so the
 * warning is asserted as hard as the exit code.
 */

import fs from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runAuditCli } from '../test-helpers.js';

let tempDir: string;
let skillPath: string;

/** A config VAT can read but not accept: a real key with an unknown child. */
const UNLOADABLE_CONFIG = 'version: 1\nresources:\n  totallyUnknownKey: true\n';

function writeSkill(dir: string, name: string): string {
  mkdirSyncReal(dir, { recursive: true });
  const target = safePath.join(dir, 'SKILL.md');
  fs.writeFileSync(
    target,
    `---\nname: ${name}\ndescription: A fixture skill governed by a config that cannot be loaded.\n---\n\n# ${name}\n\nBody text.\n`,
  );
  return target;
}

beforeAll(() => {
  tempDir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-unloadable-cfg-'));
  fs.writeFileSync(safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'), UNLOADABLE_CONFIG);
  skillPath = writeSkill(safePath.join(tempDir, 'skills', 'demo'), 'demo');
  // A SECOND skill under the SAME config, so the warning's once-per-config
  // behaviour is observable. A per-skill warning would be 851 lines on a real
  // `--user` run, which is its own way of making the message unreadable.
  writeSkill(safePath.join(tempDir, 'skills', 'demo-two'), 'demo-two');
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('vat audit with an unloadable governing config', () => {
  it('scans the tree instead of aborting, and says the config was ignored', () => {
    const result = runAuditCli(tempDir);

    // The regression: this used to be exit 2 with no skill audited at all.
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('Ignoring unloadable config');
    // The message must name the file, or it cannot be acted on.
    expect(result.stderr).toContain('vibe-agent-toolkit.config.yaml');
    // And it must not be silent about WHY the config was rejected.
    expect(result.stderr).toContain('totallyUnknownKey');
  });

  it('warns once for the config, not once per skill it governs', () => {
    const result = runAuditCli(tempDir);

    const warnings = result.stderr.split('\n').filter((l) => l.includes('Ignoring unloadable config'));
    expect(warnings).toHaveLength(1);
  });

  it('agrees with the single-target lane on the same skill', () => {
    const scan = runAuditCli(tempDir);
    const single = runAuditCli(skillPath);

    // The whole point: the answer must not depend on whether the argument was
    // the file or the directory above it. The single-target lane always
    // tolerated this; the scan lane did not.
    expect(single.status).toBe(0);
    expect(scan.status).toBe(single.status);
  });
});
