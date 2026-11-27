/**
 * The workspace step's answer as the run database takes it: its rows, or one refusal under each of
 * its relations' names, published with the code that says whether a rerun may answer.
 */

import type { WorkspaceAnswer, WorkspaceRefusal } from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import { workspaceRelations } from '../../src/utils/projection-query.js';

/** A refusal of the step, `retryable` as the test states it. */
function refusedWith(retryable: boolean): WorkspaceAnswer {
  const refusal: WorkspaceRefusal = {
    code: 'WORKSPACE_ROOT_NO_ROWS',
    root: 'r0',
    path: 'package.json',
    message: 'the root package.json has no rows this run.',
    remedy: 'run again',
    retryable,
  };
  return { outcome: 'refused', refusal };
}

describe('workspaceRelations', () => {
  it('writes the rows and refuses nothing when the step answered', () => {
    const answered = workspaceRelations({ outcome: 'rows', packages: [], dependencies: [], conditions: [] });
    expect(answered.refusals.size).toBe(0);
    expect(Object.keys(answered.rows).sort((a, b) => a.localeCompare(b))).toStrictEqual(['workspaceConditions', 'workspaceDependencies', 'workspacePackages']);
  });

  it('publishes a refusal a rerun may answer as RUN_INCOMPLETE, under every workspace relation', () => {
    const { refusals, rows } = workspaceRelations(refusedWith(true));
    expect(rows).toStrictEqual({});
    expect([...refusals.keys()].sort((a, b) => a.localeCompare(b))).toStrictEqual(['workspace_conditions', 'workspace_dependencies', 'workspace_packages']);
    expect([...refusals.values()].map(({ refusal }) => refusal)).toStrictEqual(['RUN_INCOMPLETE', 'RUN_INCOMPLETE', 'RUN_INCOMPLETE']);
    expect(refusals.get('workspace_packages')?.refused).toBe('WORKSPACE_ROOT_NO_ROWS: the root package.json has no rows this run. Fix: run again.');
  });

  it('publishes a refusal the tree decides as INPUT_UNREADABLE', () => {
    const { refusals } = workspaceRelations(refusedWith(false));
    expect(new Set([...refusals.values()].map(({ refusal }) => refusal))).toStrictEqual(new Set(['INPUT_UNREADABLE']));
  });
});
