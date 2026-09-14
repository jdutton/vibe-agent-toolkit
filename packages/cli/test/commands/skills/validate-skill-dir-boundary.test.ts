/**
 * `vat skills validate` on a strict skill: `LINK_OUTSIDE_SKILL_DIR` at `error`
 * fails the run, including for an IN-PLACE (`publish: false`) skill, which is
 * never bundled but is still validated at source through the packaging lane.
 */

import { writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { type buildValidateSummary, runSkillsValidatePhase } from '../../../src/commands/skills/validate.js';
import { resetSkillDiscoveryCache } from '../../../src/skill-resolution/packaging-config.js';
import { createTempDirTracker } from '../../system/test-common.js';

const CODE = 'LINK_OUTSIDE_SKILL_DIR';
const { createTempDir, cleanupTempDirs } = createTempDirTracker('skills-validate-boundary-');

afterAll(() => {
  cleanupTempDirs();
});

/** `skills/strict/SKILL.md` → `../shared.md`, with `lines` under `skills.config.strict`. */
function projectWithSharedDocLink(lines: string[]): string {
  const root = safePath.resolve(createTempDir());
  mkdirSyncReal(safePath.join(root, 'skills', 'strict'), { recursive: true });
  writeFileSync(safePath.join(root, 'skills', 'shared.md'), '# Shared\n');
  writeFileSync(
    safePath.join(root, 'skills', 'strict', 'SKILL.md'),
    '---\nname: strict\ndescription: A strict fixture skill whose only link leaves its own directory.\n---\n\n# strict\n\nSee [shared](../shared.md).\n',
  );
  writeFileSync(
    safePath.join(root, 'vibe-agent-toolkit.config.yaml'),
    ['skills:', '  include:', '    - "skills/strict/SKILL.md"', '  config:', '    strict:', ...lines, ''].join('\n'),
  );
  return root;
}

/** Run the phase and return its exit code and the boundary findings' severities. */
async function validateBoundary(lines: string[]): Promise<{ exitCode: number; severities: string[] }> {
  const outcome = await runSkillsValidatePhase(projectWithSharedDocLink(lines), { verbose: true });
  const [row] = (outcome.document as ReturnType<typeof buildValidateSummary>).results as Array<{
    allErrors: Array<{ code: string; severity: string }>;
  }>;
  return { exitCode: outcome.exitCode, severities: (row?.allErrors ?? []).filter((i) => i.code === CODE).map((i) => i.severity) };
}

const STRICT = ['      validation:', '        severity:', `          ${CODE}: error`];

describe('vat skills validate — the skill-directory boundary', () => {
  beforeEach(() => {
    resetSkillDiscoveryCache();
  });

  it('is silent by default', async () => {
    expect(await validateBoundary(['      publish: true'])).toEqual({ exitCode: 0, severities: [] });
  });

  it('fails a strict skill at severity error', async () => {
    expect(await validateBoundary(STRICT)).toEqual({ exitCode: 1, severities: ['error'] });
  });

  it('fails a strict IN-PLACE (publish: false) skill the same way', async () => {
    expect(await validateBoundary(['      publish: false', ...STRICT])).toEqual({ exitCode: 1, severities: ['error'] });
  });
});
