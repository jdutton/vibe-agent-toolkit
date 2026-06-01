import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { predictForSkill } from '../../src/compat-empirical/static-predict/predict.js';

const VAT_VERSION_FIXTURE = 'test';
const EXTERNAL_CLI_FIXTURE = 'external-cli-skill';
const TARGET_CHAT = 'claude-chat' as const;

const projectRoot = safePath.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

function fixturePath(scenario: string): string {
  return safePath.join(
    projectRoot,
    'packages/agent-skills/test/fixtures/compat-scenarios',
    scenario,
    'SKILL.md',
  );
}

describe('predictForSkill (integration vs. compat-scenarios)', () => {
  it('emits CAPABILITY_EXTERNAL_CLI for the external-cli-skill fixture', async () => {
    const prediction = await predictForSkill({
      skillId: EXTERNAL_CLI_FIXTURE,
      skillPath: fixturePath(EXTERNAL_CLI_FIXTURE),
      declaredTargets: ['claude-code'],
      vatVersion: VAT_VERSION_FIXTURE,
    });
    const codes = prediction.observations.map((o) => o.code);
    expect(codes).toContain('CAPABILITY_EXTERNAL_CLI');
    // Sanity: predictionError must be undefined when validation succeeds.
    expect(prediction.predictionError).toBeUndefined();
  });

  it('emits CAPABILITY_BROWSER_AUTH for the browser-auth-skill fixture', async () => {
    const prediction = await predictForSkill({
      skillId: 'browser-auth-skill',
      skillPath: fixturePath('browser-auth-skill'),
      declaredTargets: [TARGET_CHAT],
      vatVersion: VAT_VERSION_FIXTURE,
    });
    const codes = prediction.observations.map((o) => o.code);
    expect(codes).toContain('CAPABILITY_BROWSER_AUTH');

    // claude-chat has browser:yes in the profile, so CAPABILITY_BROWSER_AUTH
    // should NOT produce COMPAT_TARGET_INCOMPATIBLE.
    const chatPrediction = prediction.verdictByTarget.find((v) => v.target === TARGET_CHAT);
    expect(chatPrediction?.predictedOutcome).toBe('expected');
  });

  it('emits no observations for the portable-skill fixture', async () => {
    const prediction = await predictForSkill({
      skillId: 'portable-skill',
      skillPath: fixturePath('portable-skill'),
      declaredTargets: [TARGET_CHAT, 'claude-cowork', 'claude-code'],
      vatVersion: VAT_VERSION_FIXTURE,
    });
    expect(prediction.observations).toHaveLength(0);
    for (const perTarget of prediction.verdictByTarget) {
      expect(perTarget.predictedOutcome).toBe('expected');
    }
  });

  it('marks undeclared targets when no declaredTargets is given', async () => {
    const prediction = await predictForSkill({
      skillId: EXTERNAL_CLI_FIXTURE,
      skillPath: fixturePath(EXTERNAL_CLI_FIXTURE),
      declaredTargets: undefined,
      vatVersion: VAT_VERSION_FIXTURE,
    });
    for (const perTarget of prediction.verdictByTarget) {
      expect(perTarget.predictedOutcome).toBe('undeclared');
    }
  });
});
