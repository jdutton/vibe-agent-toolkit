/**
 * The create and delete edit kinds, run by the built candidate beside a clean
 * warm arm of the same build: every round's tree is one the store has not
 * seen (create names its file by round; delete takes a rotating window), so
 * every round is derived and valid, and the subject is left as committed.
 *
 * System-tier: real git, the built vat, warm arms under a cleared environment.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { runGit } from '../../src/harness/git-state.js';
import { cleanupVerdictFixtures } from '../integration/verdict-fixtures.js';

import { captureBuildArms, CI_C_STEPS, repetitionsOf, twelveFileSubject, UNLINKED_PAGES } from './edit-arms.js';

afterAll(cleanupVerdictFixtures);

describe('perf arms: create and delete edit arms', () => {
  it('makes every round valid for both kinds and restores the subject', async () => {
    const subject = twelveFileSubject();
    const report = await captureBuildArms(
      subject,
      [
        { arm: 'ci-c', state: 'warm', steps: CI_C_STEPS },
        { arm: 'ci-c', state: { warm: 'edit', count: 2, kind: 'create' }, steps: CI_C_STEPS },
        { arm: 'ci-c', state: { warm: 'edit', count: 1, kind: 'delete' }, steps: CI_C_STEPS },
      ],
      UNLINKED_PAGES,
    );

    expect(report.arms.map((arm) => [arm.state, arm.failure])).toEqual([
      ['warm', null],
      ['warm-edit2:create', null],
      ['warm-edit1:delete', null],
    ]);
    const created = repetitionsOf(report, 'ci-c', 'warm-edit2:create');
    expect(created.map((repetition) => repetition.edits?.paths)).toEqual([
      ['docs/lab-edit-0-0.md', 'docs/lab-edit-0-1.md'],
      ['docs/lab-edit-1-0.md', 'docs/lab-edit-1-1.md'],
      ['docs/lab-edit-2-0.md', 'docs/lab-edit-2-1.md'],
    ]);
    const deleted = repetitionsOf(report, 'ci-c', 'warm-edit1:delete');
    // A rotating window: a delete arm that repeated round 0's window was served from the store from round 1 on.
    expect(deleted.map((repetition) => repetition.edits?.paths)).toEqual(UNLINKED_PAGES.map((page) => [page]));
    for (const repetition of [...created, ...deleted]) {
      expect(repetition.violation).toBeNull();
      expect(repetition.steps.map((step) => step.provenance?.resources)).toEqual(['derived']);
    }
    expect(created.map((repetition) => repetition.edits?.changed)).toEqual([2, 2, 2]);
    expect(deleted.map((repetition) => repetition.edits?.changed)).toEqual([1, 1, 1]);
    expect(runGit(['status', '--porcelain', '--untracked-files=all'], subject).stdout).toBe('');
  });
});
