/**
 * The exit-code matrix, one OUTCOME across every document verb that takes a
 * path: a path under a parent the process may not traverse. The path cannot be
 * stat'ed, so whether it exists is unknown — it is the INPUT's refusal, never
 * "does not exist", and never a scan that starts anyway. One classifier
 * (`classifyFsFault`, a `source` fault named by the argument) decides it, and it
 * ends on 2 in every verb.
 *
 * The matrix's other files and what holds them together:
 * `exit-code-matrix.system.test.ts`.
 */

import { safePath } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { describe, it } from 'vitest';

import { matrixTempDir, useMatrixTempDir } from './test-helpers/exit-code-matrix.js';
import { expectUnreadableRefusal, PATH_VERBS } from './test-helpers/exit-code-path-verbs.js';

describe('exit codes are derived from the published document — a path under a parent the OS will not traverse (system test)', () => {
  useMatrixTempDir();

  // The assertions are in `expectUnreadableRefusal`: the exit code, a published
  // document, and the refusal code the verb names.
  it.skipIf(CANNOT_DENY_READS).each(PATH_VERBS)(
    '$verb over a path under a parent the OS will not traverse ends on ERROR',
    ({ verb, args }) => {
      const parent = safePath.join(matrixTempDir(), 'untraversable');
      expectUnreadableRefusal(verb, args, safePath.join(parent, 'child'), parent);
    },
  );
});
