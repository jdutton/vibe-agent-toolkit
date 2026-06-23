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

/**
 * RICH_FIXTURE — byte-surgical regression fixture.
 *
 * Intentionally carries: inline comments on multiple unrelated keys,
 * a flow array, a long (>80-char) quoted string, one skill with an
 * existing test block (report-tool) and one without (acme-skill).
 * The goal: prove upsertTestConfig never reflows content it didn't touch.
 */
const RICH_FIXTURE = `version: 1  # config version comment
skills:
  include: ["skills/**/SKILL.md"]  # flow array with inline comment
  config:
    acme-skill:
      publish: false   # opt-out
      description: "A very long description that is definitely more than eighty characters wide to verify no line-wrap avoidance"
    report-tool:
      publish: true   # keep me
      test:
        auth: inherit
        maxTurns: 10  # turn cap
`;

/**
 * Returns all lines from `yaml` that do NOT include any of the given marker substrings.
 * Used to verify that lines unrelated to a change are byte-identical before and after.
 */
function linesExcluding(yaml: string, ...markers: string[]): string[] {
  return yaml.split('\n').filter((line) => !markers.some((m) => line.includes(m)));
}

/**
 * Returns the portion of `yaml` starting from (and including) the first occurrence
 * of `anchor`. Throws if the anchor is not found, which guards against fixture drift.
 */
function tailFrom(yaml: string, anchor: string): string {
  const idx = yaml.indexOf(anchor);
  if (idx === -1) throw new Error(`tailFrom: anchor not found in YAML: ${JSON.stringify(anchor)}`);
  return yaml.slice(idx);
}

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

describe('upsertTestConfig — byte-surgical regression', () => {
  it('1-knob insert into existing test block leaves every other line byte-identical', () => {
    // Fixture: report-tool has test block (auth + maxTurns), but no model.
    const model = 'claude-3-5-haiku-20241022';
    const out = upsertTestConfig(RICH_FIXTURE, 'report-tool', { model });
    // The model line did not exist in the fixture — after upsert it must appear exactly once.
    expect(out).toContain(`model: ${model}`);
    // Every line that does NOT contain the new model value must be byte-identical to input.
    // linesExcluding(RICH_FIXTURE, model) === all lines of RICH_FIXTURE (model absent in input).
    // linesExcluding(out, model)          === all lines of out minus the one new model line.
    // Equality proves: (a) nothing else changed, (b) nothing was re-ordered or reflowed.
    expect(linesExcluding(out, model)).toEqual(linesExcluding(RICH_FIXTURE, model));
    // Inline comments and special formatting confirmed intact
    expect(out).toContain('# flow array with inline comment');
    expect(out).toContain('"A very long description that is definitely more than eighty characters wide to verify no line-wrap avoidance"');
    expect(out).toContain('maxTurns: 10  # turn cap');
  });

  it('init-case insert splices only the new test block; post-block content is byte-identical', () => {
    // acme-skill has no test block; report-tool follows it and must be untouched.
    const model = 'claude-opus-4-5';
    const out = upsertTestConfig(RICH_FIXTURE, 'acme-skill', { model });
    // Everything from report-tool onwards must be byte-identical to input.
    const anchor = '\n    report-tool:';
    expect(tailFrom(out, anchor)).toBe(tailFrom(RICH_FIXTURE, anchor));
    // Inline comments, flow array, and long string in the pre-insertion section are intact.
    expect(out).toContain('# config version comment');
    expect(out).toContain('["skills/**/SKILL.md"]  # flow array with inline comment');
    expect(out).toContain('"A very long description that is definitely more than eighty characters wide to verify no line-wrap avoidance"');
    expect(out).toContain('# opt-out');
    // The test block was created with the correct value and round-trips through the schema.
    const parsed = parse(out) as { skills: { config: Record<string, { test: Record<string, unknown> }> } };
    expect(parsed.skills.config['acme-skill']?.test?.['model']).toBe(model);
    expect(() => TestConfigSchema.parse(parsed.skills.config['acme-skill']?.test)).not.toThrow();
  });

  it('replacing one knob in existing test block preserves sibling knobs and their comments', () => {
    // report-tool.test has auth + maxTurns; we overwrite auth only.
    const out = upsertTestConfig(RICH_FIXTURE, 'report-tool', { auth: 'subscription' });
    // Same line count: this is a replace, not an insert.
    expect(out.split('\n').length).toBe(RICH_FIXTURE.split('\n').length);
    // Sibling knob with its inline comment is byte-identical.
    expect(out).toContain('maxTurns: 10  # turn cap');
    // Lines not containing any auth key are byte-identical to input.
    const stripAuth = (yaml: string): string[] => yaml.split('\n').filter((l) => !l.trimStart().startsWith('auth:'));
    expect(stripAuth(out)).toEqual(stripAuth(RICH_FIXTURE));
    // The knob actually changed.
    const parsed = parse(out) as { skills: { config: Record<string, { test: Record<string, unknown> }> } };
    expect(parsed.skills.config['report-tool']?.test?.['auth']).toBe('subscription');
  });
});
