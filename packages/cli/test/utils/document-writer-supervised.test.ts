/**
 * A supervised child leaves every finding to the supervisor that forwards its document: its
 * writer prints none, so no finding prints twice across the parent/child boundary. Its own file,
 * because the switch is process-wide and never turned back off.
 */

import { buildReport, type Finding } from '@vibe-agent-toolkit/schema';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import {
  endWithRefusal,
  findingsGoToStderr,
  leaveFindingsToSupervisor,
  leftoverIssue,
  NOTHING_FINISHED,
  writeDocument,
} from '../../src/utils/document-writer.js';

const FINDING: Finding = { code: 'OKF_CONCEPT_MISSING_TYPE', severity: 'error', message: 'concept has no type' };

let stderr: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a supervised child\'s writer', () => {
  it('prints no finding once it leaves them to its supervisor', () => {
    expect(findingsGoToStderr('resources check', 'json')).toBe(true);
    leaveFindingsToSupervisor();

    expect(findingsGoToStderr('resources check', 'json')).toBe(false);
    // Zero examined: the writer's own run-integrity refusal is added, and not said here.
    writeDocument('okf validate', buildReport({ examined: 0, findings: [], data: { bundles: [] }, gate: { strict: false } }), 'json');
    endWithRefusal('okf validate', 'INPUT_UNREADABLE', 'refused', 'yaml', { strict: false }, { ...NOTHING_FINISHED, findings: [FINDING, leftoverIssue('left behind', '/tmp/left')] });

    const said = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(said).toBe('refused\n');
  });
});
