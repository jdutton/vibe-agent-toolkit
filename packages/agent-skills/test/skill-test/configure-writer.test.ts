import { TestConfigSchema } from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { upsertTestConfig } from '../../src/skill-test/configure-writer.js';

const BASE = `version: 1
skills:
  include: ["skills/**/SKILL.md"]
  config:
    my-skill:
      publish: true   # keep me
`;

describe('upsertTestConfig', () => {
  it('initializes a full test block when absent', () => {
    const out = upsertTestConfig(BASE, 'my-skill', { auth: 'subscription', baseline: false });
    const parsed = parse(out) as { skills: { config: Record<string, { test: unknown }> } };
    expect(parsed.skills.config['my-skill']?.test).toBeDefined();
    expect((parsed.skills.config['my-skill']?.test as Record<string, unknown>)?.['auth']).toBe('subscription');
    // output round-trips through the strict schema:
    expect(() => TestConfigSchema.parse(parsed.skills.config['my-skill']?.test)).not.toThrow();
  });

  it('preserves an unrelated comment on a sibling key', () => {
    const out = upsertTestConfig(BASE, 'my-skill', { auth: 'inherit' });
    expect(out).toContain('# keep me');
  });

  it('surgically updates only the specified knob, leaving others intact', () => {
    const once = upsertTestConfig(BASE, 'my-skill', { auth: 'api-key', maxTurns: 30 });
    const twice = upsertTestConfig(once, 'my-skill', { auth: 'subscription' });
    const parsed = parse(twice) as { skills: { config: Record<string, { test: Record<string, unknown> }> } };
    expect(parsed.skills.config['my-skill']?.test?.['auth']).toBe('subscription');
    expect(parsed.skills.config['my-skill']?.test?.['maxTurns']).toBe(30);
  });

  it('creates skills.config.<skill> when the skill is not yet present', () => {
    const out = upsertTestConfig('version: 1\nskills:\n  include: ["s/**/SKILL.md"]\n', 'new-skill', { auth: 'auto' });
    const parsed = parse(out) as { skills: { config: Record<string, { test: Record<string, unknown> }> } };
    expect(parsed.skills.config['new-skill']?.test?.['auth']).toBe('auto');
  });
});
