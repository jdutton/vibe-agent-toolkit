/**
 * `skills delete --all` deletes every VERSION before it can delete the skill,
 * and the API refuses the skill while any version remains. So the sweep is the
 * whole command, and what it does when one version refuses is the whole design.
 *
 * 🚨 It used to `return` on the first refusal. The remaining versions were never
 * ATTEMPTED — not "failed", not reported: unexamined — so an operator who hit a
 * single transient refusal was left with a skill that could not be deleted by
 * re-running the command either, because nothing told them which versions were
 * still there. One refusal is a fact about one version; it is not a fact about
 * the ones after it.
 */

import type { OrgApiClient } from '@vibe-agent-toolkit/claude-marketplace';
import { describe, expect, it } from 'vitest';

import { buildOrgCommandEnding } from '../src/commands/claude/org/helpers.js';
import {
  deleteEveryVersion,
  describeVersionSweepFailures,
  reportHalfDeleted,
} from '../src/commands/claude/org/skills.js';

import { recordingLogger } from './helpers/upload-logger.js';

/**
 * A client that refuses exactly the versions named and accepts the rest,
 * recording every version it was ASKED about — which is the fact these tests
 * turn on, since the defect was versions never being asked about at all.
 */
function clientRefusing(refused: Record<string, string>): {
  client: OrgApiClient;
  attempted: string[];
} {
  const attempted: string[] = [];
  const deleteSkillVersion = (_skillId: string, version: string): Promise<unknown> => {
    attempted.push(version);
    const reason = refused[version];
    return reason === undefined ? Promise.resolve(undefined) : Promise.reject(new Error(reason));
  };
  return { client: { deleteSkillVersion } as unknown as OrgApiClient, attempted };
}

/** The refusal every fixture in this suite scripts. */
const RATE_LIMITED = 'API error 429: rate limited';

describe('deleteEveryVersion', () => {
  it('attempts every version even after one refuses, and records both outcomes', async () => {
    const { client, attempted } = clientRefusing({ v2: RATE_LIMITED });
    const logger = recordingLogger();

    const sweep = await deleteEveryVersion(client, 'skill_abc', ['v1', 'v2', 'v3'], logger);

    // The loop CONTINUED: v3 was tried, which the old code never did.
    expect(attempted).toEqual(['v1', 'v2', 'v3']);
    expect(sweep.deleted).toEqual(['v1', 'v3']);
    expect(sweep.failures).toEqual([{ version: 'v2', reason: RATE_LIMITED }]);
  });

  it('records the version that WAS deleted when the very first one refuses', async () => {
    const { client, attempted } = clientRefusing({ v1: 'API error 500: boom' });

    const sweep = await deleteEveryVersion(client, 'skill_abc', ['v1', 'v2'], recordingLogger());

    expect(attempted).toEqual(['v1', 'v2']);
    expect(sweep.deleted).toEqual(['v2']);
  });

  it('reports a clean sweep with no failures', async () => {
    const { client } = clientRefusing({});

    const sweep = await deleteEveryVersion(client, 'skill_abc', ['v1', 'v2'], recordingLogger());

    expect(sweep.deleted).toEqual(['v1', 'v2']);
    expect(sweep.failures).toEqual([]);
  });

  it('tells the operator which version failed, as it happens', async () => {
    const { client } = clientRefusing({ v2: RATE_LIMITED });
    const logger = recordingLogger();

    await deleteEveryVersion(client, 'skill_abc', ['v1', 'v2', 'v3'], logger);

    const log = logger.lines.join('\n');
    expect(log).toContain('Deleted version v1');
    expect(log).toContain('v2 was not deleted');
    expect(log).toContain('Deleted version v3');
  });
});

describe('describeVersionSweepFailures', () => {
  it('names every version that failed and why, not just the first', () => {
    const said = describeVersionSweepFailures([
      { version: 'v2', reason: RATE_LIMITED },
      { version: 'v5', reason: 'API error 503: unavailable' },
    ]);

    expect(said).toContain('v2');
    expect(said).toContain('v5');
    expect(said).toContain('rate limited');
    expect(said).toContain('unavailable');
  });
});

describe('reportHalfDeleted', () => {
  it('exits 1 and publishes both lists, so the operator can finish the job', () => {
    const ending = buildOrgCommandEnding(reportHalfDeleted({
      skillId: 'skill_abc',
      deletedVersions: ['v1', 'v3'],
      failedVersions: ['v2'],
      error: 'v2: API error 429: rate limited',
    }), 5);

    expect(ending.exitCode).toBe(1);
    expect(ending.document['status']).toBe('error');
    expect(ending.document['deleted']).toBe(false);
    // The record of what is already gone — irreversible, and unreconstructable
    // from anywhere else.
    expect(ending.document['deletedVersions']).toEqual(['v1', 'v3']);
    // …and what is still there, which is what a re-run has to deal with.
    expect(ending.document['failedVersions']).toEqual(['v2']);
    expect(String(ending.document['note'])).toContain('still exists');
  });

  it('keeps the failure tag out of the published document', () => {
    const ending = buildOrgCommandEnding(reportHalfDeleted({
      skillId: 'skill_abc',
      deletedVersions: ['v1'],
      failedVersions: [],
      error: 'API error 400: cannot delete',
    }), 5);

    expect(ending.document).not.toHaveProperty('orgCommandFailed');
    expect(ending.document).not.toHaveProperty('document');
  });
});
