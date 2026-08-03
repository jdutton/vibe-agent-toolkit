/* eslint-disable security/detect-non-literal-fs-filename -- every path here is a temp dir the test owns */
/**
 * `vat skills validate <path>` and `vat skills build <path>` must REFUSE a path
 * they cannot read a config from, not rescope the run to nothing and call that
 * success.
 *
 * The sibling defect to the one `excess-arguments.test.ts` pins. There,
 * `vat verify <path>` discarded the path and went WIDE over the whole project,
 * reporting success for a scan the operator never asked for. Here the path is
 * kept and the run goes NARROW: in a package whose bare `vat skills validate`
 * finds 13 skills, `vat skills validate nope` printed "No skills section in
 * config yaml — nothing to validate" and exited 0. Both hand back a green tick
 * for a scan that did not happen; only the direction differs.
 *
 * `vat skills build` carried the identical hole and is the worse of the two: a
 * release pipeline whose build step named the wrong directory published having
 * built nothing, and reported success. Both are driven from ONE table below —
 * the pair drifted in the first place because the fix was written for one
 * command, and a copied test would let it drift again.
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

import { createBuildCommand } from '../../../src/commands/skills/build.js';
import { CONFIG_FILENAME, unscopableSkillsPath } from '../../../src/commands/skills/scope-guard.js';
import { createValidateCommand } from '../../../src/commands/skills/validate-command.js';
import { createTempDirTracker } from '../../system/test-common.js';
import { captureProcessExit, type CapturedExit } from '../../test-doubles.js';

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-skills-path-scope-');

/** A directory holding a real config — the scope the commands CAN honour. */
function scopableDir(): string {
  const dir = createTempDir();
  writeFileSync(safePath.join(dir, CONFIG_FILENAME), 'version: 1\n', 'utf-8');
  return dir;
}

/** Parse `argv` through the real command, capturing stderr and the exit code. */
async function runCommand(command: Command, argv: string[]): Promise<CapturedExit> {
  return captureProcessExit(async () => {
    await command.parseAsync(argv, { from: 'user' });
  });
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
 * "nothing to do" and exits 0.
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
    // predicate that rejects everything, and the commands would refuse to run
    // at all.
    expect(unscopableSkillsPath(scopableDir())).toBeUndefined();
  });

  it('accepts no argument at all — that means "the current directory"', () => {
    // The bare invocation is the documented default and must not be disturbed,
    // including in a cwd that genuinely holds no config: "nothing to do" is the
    // right answer to a question nobody scoped.
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

/**
 * Every skills command taking `[path]`, with the words its own silent success
 * used to print.
 *
 * `silentBanner` is the load-bearing column, and the exit code is not. ALONE
 * the code cannot see this bug: `captureProcessExit` stubs `process.exit` to
 * throw, both commands wrap their body in try/catch, so the unguarded
 * `process.exit(0)` on the nothing-to-do path is caught by the command's own
 * error handler and re-reported as exit 2. **An unguarded command exits 2 here
 * too.** A test asserting only the code passes against the unfixed build. The
 * run announcing it found nothing to do is the only observable that separates
 * the two answers.
 *
 * `quotedPhrase` is the short phrase the refusal quotes back as evidence. It is
 * a SUBSTRING of the banner but distinct from it, which is what lets the same
 * stderr be asserted to contain one and not the other.
 */
const SCOPED_COMMANDS = [
  {
    spelling: 'vat skills validate',
    create: createValidateCommand,
    silentBanner: 'No skills section in config yaml',
    quotedPhrase: 'nothing to validate',
  },
  {
    spelling: 'vat skills build',
    create: createBuildCommand,
    silentBanner: 'No skills configuration found',
    quotedPhrase: 'nothing to build',
  },
] as const;

describe.each(SCOPED_COMMANDS)(
  '$spelling rejects an unscopable path argument',
  ({ spelling, create, silentBanner, quotedPhrase }) => {
    afterEach(() => {
      cleanupTempDirs();
    });

    it('exits 2 rather than reporting success for a run that never happened', async () => {
      const { exited, stderr } = await runCommand(create(), [mistypedSubdirOfProject()]);

      // 2, not 1: exit 1 on these commands is documented as "errors found", and
      // a usage error reported as 1 tells a CI gate the project's skills are
      // broken when nothing was inspected at all.
      expect(exited).toBe(2);
      expect(stderr).not.toContain(silentBanner);
      expect(stderr).toContain('cannot scope to');
    });

    it('names the path, the command, and what a path is supposed to point at', async () => {
      const missing = mistypedSubdirOfProject();

      const { stderr } = await runCommand(create(), [missing]);

      expect(stderr).toContain(missing);
      expect(stderr).toContain(spelling);
      expect(stderr).toContain(CONFIG_FILENAME);
      // The command that DOES take an arbitrary path.
      expect(stderr).toContain('vat audit <path>');
    });

    it('quotes back the silent success it replaced, so the message names the real defect', async () => {
      // Not decoration: this is what makes the refusal legible to the operator
      // staring at a pipeline that used to be green. It is also the assertion
      // that catches the two commands being wired to one another's subject —
      // the failure mode of sharing one guard between them.
      const { stderr } = await runCommand(create(), [mistypedSubdirOfProject()]);

      expect(stderr).toContain(quotedPhrase);
      expect(stderr).toContain('exited 0');
    });

    it('does NOT refuse a path that holds a config', async () => {
      // The wiring control. Without it, a guard that rejects unconditionally
      // satisfies every test above while breaking the command outright.
      //
      // Only stderr is asserted, deliberately. The exit code cannot serve here:
      // this fixture's config declares no skills, so the command reaches its
      // own nothing-to-do path and calls process.exit(0) — which the stub turns
      // into a throw, which the command's try/catch re-reports as 2. Asserting
      // a code would pin the harness's artifact, not the guard.
      const { stderr } = await runCommand(create(), [scopableDir(), '--dry-run']);

      expect(stderr).not.toContain('cannot scope to');
    });
  },
);
