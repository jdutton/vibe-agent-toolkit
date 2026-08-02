/* eslint-disable security/detect-non-literal-fs-filename -- every path here is a temp dir the test owns */
/**
 * `vat skills validate <path>` must REFUSE a path it cannot read a config from,
 * not rescope the run to nothing and call that success.
 *
 * The sibling defect to the one `excess-arguments.test.ts` pins. There,
 * `vat verify <path>` discarded the path and went WIDE over the whole project,
 * reporting success for a scan the operator never asked for. Here the path is
 * kept and the run goes NARROW: in a package whose bare `vat skills validate`
 * finds 13 skills, `vat skills validate nope` printed "No skills section in
 * config yaml — nothing to validate" and exited 0. Both hand back a green tick
 * for a scan that did not happen; only the direction differs.
 *
 * The pure predicate is asserted in BOTH directions from fixtures that differ by
 * one property, so neither "always reject" nor "never reject" can satisfy it,
 * and the exit code is driven through the real Command object — the wiring is
 * the only way a working predicate still ships a silent success.
 */

import { writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import type { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createValidateCommand,
  unscopableSkillsPath,
} from '../../../src/commands/skills/validate-command.js';
import { createTempDirTracker } from '../../system/test-common.js';
import { captureProcessExit, type CapturedExit } from '../../test-doubles.js';

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-skills-validate-scope-');

const CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';

/** A directory holding a real config — the scope the command CAN honour. */
function scopableDir(): string {
  const dir = createTempDir();
  writeFileSync(safePath.join(dir, CONFIG_FILENAME), 'version: 1\n', 'utf-8');
  return dir;
}

/** Parse `argv` through the real command, capturing stderr and the exit code. */
async function runCommand(command: Command, argv: string[]): Promise<CapturedExit> {
  return captureProcessExit(() => command.parseAsync(argv, { from: 'user' }));
}

/**
 * A mistyped subdirectory of a REAL project root.
 *
 * The parent matters, and an unwired guard is indistinguishable from a wired
 * one without it: `requireProjectRoot` walks UP from the argument, so a missing
 * path with no project ancestor already exits 2 on its own — for an unrelated
 * reason — and a test built on one agrees with an implementation that never
 * checks the path at all. With a config in the parent that guard passes,
 * `loadConfig` finds nothing in the named directory, and the run reports
 * "nothing to validate" and exits 0.
 */
function mistypedSubdirOfProject(): string {
  return safePath.join(scopableDir(), 'nope');
}

describe('unscopableSkillsPath', () => {
  afterEach(() => {
    delete process.env['VAT_TEST_CONFIG'];
    cleanupTempDirs();
  });

  it('accepts a directory that holds a config', () => {
    // The control. Without it, every rejection below is satisfied by a
    // predicate that rejects everything, and the command would refuse to run
    // at all.
    expect(unscopableSkillsPath(scopableDir())).toBeUndefined();
  });

  it('accepts no argument at all — that means "the current directory"', () => {
    // The bare invocation is the documented default and must not be disturbed,
    // including in a cwd that genuinely holds no config: "nothing to validate"
    // is the right answer to a question nobody scoped.
    expect(unscopableSkillsPath(undefined)).toBeUndefined();
  });

  it('rejects a path that does not exist', () => {
    const missing = safePath.join(createTempDir(), 'nope');
    expect(unscopableSkillsPath(missing)).toBe('no such directory');
  });

  it('rejects a path that exists but is a file', () => {
    const dir = createTempDir();
    const file = safePath.join(dir, CONFIG_FILENAME);
    writeFileSync(file, 'version: 1\n', 'utf-8');
    expect(unscopableSkillsPath(file)).toBe('not a directory');
  });

  it('rejects a directory that holds no config — the run would find no skills there', () => {
    const empty = safePath.join(createTempDir(), 'sub');
    mkdirSyncReal(empty, { recursive: true });
    expect(unscopableSkillsPath(empty)).toContain(CONFIG_FILENAME);
  });

  it('honours VAT_TEST_CONFIG, which relocates the config off the named directory', () => {
    // Same fixture as the rejection above, differing only in the override, so
    // this pins the exemption rather than agreeing with a predicate that never
    // looks for a config.
    const empty = safePath.join(createTempDir(), 'sub');
    mkdirSyncReal(empty, { recursive: true });
    expect(unscopableSkillsPath(empty)).toContain(CONFIG_FILENAME);

    process.env['VAT_TEST_CONFIG'] = safePath.join(scopableDir(), CONFIG_FILENAME);
    expect(unscopableSkillsPath(empty)).toBeUndefined();
  });
});

describe('vat skills validate rejects an unscopable path argument', () => {
  afterEach(() => {
    cleanupTempDirs();
  });

  it('exits 2 rather than reporting success for a scan that never ran', async () => {
    const { exited, stderr } = await runCommand(createValidateCommand(), [mistypedSubdirOfProject()]);

    // 2, not 1: exit 1 on this command is documented as "validation errors
    // found", and a usage error reported as 1 tells a CI gate the project's
    // skills are broken when nothing was inspected at all.
    expect(exited).toBe(2);

    // The exit code ALONE cannot see this bug, and asserting it alone would add
    // another test incapable of failing. `captureProcessExit` stubs
    // `process.exit` to throw, `validateCommand` wraps its body in try/catch, so
    // the unguarded `process.exit(0)` on the "nothing to validate" path is caught
    // by the command's own error handler and re-reported as exit 2. The run
    // saying it found nothing to do is the observable that separates the two.
    expect(stderr).not.toContain('No skills section in config yaml');
    expect(stderr).toContain('cannot scope to');
  });

  it('names the path, the command, and what a path is supposed to point at', async () => {
    const missing = mistypedSubdirOfProject();

    const { stderr } = await runCommand(createValidateCommand(), [missing]);

    expect(stderr).toContain(missing);
    expect(stderr).toContain('vat skills validate');
    expect(stderr).toContain(CONFIG_FILENAME);
    // The command that DOES take an arbitrary path.
    expect(stderr).toContain('vat audit <path>');
  });
});
