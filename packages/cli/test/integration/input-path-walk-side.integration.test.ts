/**
 * `requireInputPath` charges a refusal to the side of the path the OS refused. An input named inside a
 * project is reached by walking each component beneath the project root, and a component it may not
 * examine — `<project>/dist`, the tree a build writes — is refused on THAT directory's side, never on
 * the input's: a destination the build cannot look into stops the run (`RUN_INCOMPLETE`), it is not
 * "the input is unreadable".
 */

import { chmodSync, writeFileSync } from 'node:fs';

import { everywhere, mkdirSyncReal, safePath, sideWithin } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS, tempDirTracker } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { refusalCodeOf } from '../../src/utils/command-refusal.js';
import { requireInputPath } from '../../src/utils/project-root-policy.js';
import { thrownBy } from '../helpers/refusal-doubles.js';

const scratch = tempDirTracker('input-path-walk-side-');
afterEach(() => scratch.cleanupAll());

const ABSENT = { origin: 'content', message: 'Skill "fx" not built.' } as const;

describe('requireInputPath over a walked input', () => {
  // chmod 000 does not restrict access on Windows, and root bypasses permission checks.
  it.skipIf(CANNOT_DENY_READS)('charges a component it may not examine to that component\'s side', () => {
    const project = scratch.create();
    // `dist/` may not be searched, so the walk's `lstat` of `dist/skills` — a component above the input — is refused.
    const dist = mkdirSyncReal(safePath.join(project, 'dist'));
    const skills = mkdirSyncReal(safePath.join(dist, 'skills'));
    const input = mkdirSyncReal(safePath.join(skills, 'fx'));
    writeFileSync(safePath.join(input, 'SKILL.md'), '# fx\n');
    chmodSync(dist, 0o600);
    try {
      const error = thrownBy(() => requireInputPath(input, project, ABSENT, sideWithin(input, 'source', 'destination')));
      expect(error).toMatchObject({ side: 'destination', faultClass: 'refused', errno: 'EACCES' });
      expect(refusalCodeOf(error)).toBe('RUN_INCOMPLETE');
    } finally {
      chmodSync(dist, 0o700);
    }
  });

  // `vat build` reads `dist/skills` its own skills phase wrote: a skill missing there is the run's own
  // output gone, which the table refuses as the run not finishing — still in the caller's words.
  it('refuses an absent input on the side it is on, in the caller\'s words', () => {
    const project = scratch.create();
    const missing = safePath.join(project, 'dist', 'skills', 'fx');
    const error = thrownBy(() => requireInputPath(missing, project, ABSENT, everywhere('destination')));
    expect(refusalCodeOf(error)).toBe('RUN_INCOMPLETE');
    expect((error as Error).message).toBe(ABSENT.message);
    expect(refusalCodeOf(thrownBy(() => requireInputPath(missing, project, ABSENT, everywhere('source'))))).toBe('INPUT_UNREADABLE');
  });
});
