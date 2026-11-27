/**
 * The exit-code matrix, one OUTCOME across every document verb that takes a
 * path: a directory the OS will not list. Nothing under it can be examined, so
 * it is the INPUT's refusal and ends on 2 in every verb. Beside it, the same
 * outcome for the one file every project verb reads: its config, and for the
 * file `vat skills package` is handed: a SKILL.md it can stat but not read.
 *
 * The matrix's other files and what holds them together:
 * `exit-code-matrix.system.test.ts`.
 */

import { chmodSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { describe, it } from 'vitest';

import { matrixTempDir, UNREADABLE, useMatrixTempDir } from './test-helpers/exit-code-matrix.js';
import { expectConfigRefusal, expectUnreadableRefusal, PATH_VERBS } from './test-helpers/exit-code-path-verbs.js';

/**
 * The verbs that read the project config through resources' `parseConfigFile`
 * (the CLI's own loader has always coded this): a config the OS will not read
 * is the user's input — INPUT_UNREADABLE, never INTERNAL_ERROR with a stack.
 */
const CONFIG_READERS: ReadonlyArray<{ readonly verb: string; readonly args: readonly string[] }> = [
  { verb: 'okf validate', args: ['okf', 'validate', '--format', 'json'] },
  { verb: 'claude plugin build', args: ['claude', 'plugin', 'build'] },
  { verb: 'claude marketplace publish', args: ['claude', 'marketplace', 'publish', '--dry-run'] },
];

describe('exit codes are derived from the published document — a directory or config the OS will not read (system test)', () => {
  useMatrixTempDir();

  // The assertions are in `expectUnreadableRefusal` / `expectConfigRefusal`: the
  // exit code, a published document, and the refusal code the verb names.
  describe('ONE outcome, one code: a path argument the OS will not list', () => {
    it.skipIf(CANNOT_DENY_READS).each(PATH_VERBS)(
      '$verb over a directory the OS will not list ends on ERROR',
      ({ verb, args }) => {
        const locked = safePath.join(matrixTempDir(), 'locked');
        expectUnreadableRefusal(verb, args, locked, locked);
      },
    );
  });

  describe('a project config the OS will not read is INPUT_UNREADABLE', () => {
    // A directory where the file should be: EISDIR on every platform.
    it.each(CONFIG_READERS)('$verb with a directory at the config path ends on ERROR', ({ verb, args }) => {
      expectConfigRefusal(`config-dir-${verb.replaceAll(' ', '-')}`, args, (configPath) => mkdirSyncReal(configPath));
    });

    it.skipIf(CANNOT_DENY_READS).each(CONFIG_READERS)('$verb with a mode-000 config ends on ERROR', ({ verb, args }) => {
      expectConfigRefusal(`config-000-${verb.replaceAll(' ', '-')}`, args, (configPath) => {
        writeFileSync(configPath, '{}\n');
        chmodSync(configPath, UNREADABLE);
      });
    });
  });

  // The stat that names the argument reads nothing, so the refusal is the gate's coded read: the
  // run's one read of the file, which the packager would then have been served.
  it.skipIf(CANNOT_DENY_READS)('skills package over a mode-000 SKILL.md is INPUT_UNREADABLE', () => {
    expectConfigRefusal('skill-000-skills-package', ['skills', 'package', 'SKILL.md', '-o', 'packaged'], (configPath) => {
      writeFileSync(configPath, '{}\n');
      const skillFile = safePath.join(dirname(configPath), 'SKILL.md');
      writeFileSync(skillFile, '---\nname: locked\ndescription: locked - a skill the OS will not read\n---\n\n# Locked\n');
      chmodSync(skillFile, UNREADABLE);
    });
  });
});
