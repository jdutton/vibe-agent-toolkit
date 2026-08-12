/**
 * The verdict lane's half of the anchor contract.
 *
 * `ValidationIssue.location` is a project-relative POSIX path. The verdict
 * helpers are the one producer that took its location as a caller-supplied
 * string, so each of the four call sites got its own chance to answer
 * "relative to what?" — and three of them answered "absolute". The result was
 * a single `vat skill review --yaml` document carrying two coordinate systems
 * (relative locations from the packaging validator, an absolute one from the
 * verdict), plus a full home-directory path leaked into `vat skills validate`.
 *
 * These tests pin the fix: the helpers re-base internally, so no caller can
 * emit an absolute location.
 */

import type { Observation } from '@vibe-agent-toolkit/agent-skills';
import type { ValidationIssue } from '@vibe-agent-toolkit/schema';
import { isAbsoluteAnyPlatform, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { computeConfigVerdicts } from '../../src/utils/verdict-helpers.js';

/** A local-shell observation, which `claude-chat` cannot satisfy. */
const SHELL_OBSERVATION: Observation = {
  code: 'CAPABILITY_LOCAL_SHELL',
  summary: 'Skill requires a local shell environment.',
  supportingEvidence: ['bash-fence'],
};

const PROJECT_ROOT = safePath.join(safePath.resolve('/'), 'repo');
const SKILL_PATH = safePath.join(PROJECT_ROOT, 'skills', 'shell-skill', 'SKILL.md');
const EXPECTED_LOCATION = 'skills/shell-skill/SKILL.md';
/** A target with no local shell, so the observation resolves to a real verdict. */
const SHELL_LESS_TARGETS = ['claude-chat'] as const;

/** Every caller passes an ABSOLUTE skill path — that is the shape being pinned. */
function verdictsForAbsoluteSkillPath(): ValidationIssue[] {
  return computeConfigVerdicts([SHELL_OBSERVATION], SHELL_LESS_TARGETS, SKILL_PATH, PROJECT_ROOT);
}

describe('computeConfigVerdicts anchor contract', () => {
  it('produces a verdict at all (guards against a vacuous fixture)', () => {
    const issues = verdictsForAbsoluteSkillPath();
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.map((i) => i.code)).toContain('COMPAT_TARGET_INCOMPATIBLE');
  });

  it('re-bases the location against the supplied root', () => {
    for (const issue of verdictsForAbsoluteSkillPath()) {
      expect(issue.location, issue.code).toBe(EXPECTED_LOCATION);
    }
  });

  it('never emits an absolute location, whatever the caller passes', () => {
    // The defect this pins: every caller passed an absolute skill path, and
    // three of them had no root to re-base it against.
    const absolute = verdictsForAbsoluteSkillPath().filter(
      (i) => i.location !== undefined && isAbsoluteAnyPlatform(i.location),
    );
    expect(absolute.map((i) => `${i.code} location=${String(i.location)}`)).toEqual([]);
  });

  it('never emits a backslash in location', () => {
    const backslashed = verdictsForAbsoluteSkillPath().filter((i) => i.location?.includes('\\'));
    expect(backslashed.map((i) => i.code)).toEqual([]);
  });
});
