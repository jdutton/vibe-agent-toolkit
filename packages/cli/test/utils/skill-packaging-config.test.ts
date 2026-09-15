/**
 * `isSkillPublished` — THE predicate every lane asks before treating a skill as
 * a pool bundle (`dist/skills/<name>`).
 *
 * It reads the MERGED packaging config, so `skills.defaults.publish` counts. The
 * consistency check used to read `skills.config.<name>.publish` alone, which made
 * `skills.defaults.publish: false` parse, validate, and change nothing.
 */

import { describe, expect, it } from 'vitest';

import { isSkillPublished, mergeSkillPackagingConfig, pluginLocalSkillConfigEntry } from '../../src/utils/skill-packaging-config.js';

describe('isSkillPublished', () => {
  it('defaults to true when neither defaults nor the per-skill block say', () => {
    expect(isSkillPublished(mergeSkillPackagingConfig(undefined, undefined))).toBe(true);
    expect(isSkillPublished(mergeSkillPackagingConfig({ linkFollowDepth: 1 }, {}))).toBe(true);
  });

  it('honours skills.defaults.publish: false — every skill is in-place unless it opts back in', () => {
    expect(isSkillPublished(mergeSkillPackagingConfig({ publish: false }, undefined))).toBe(false);
    expect(isSkillPublished(mergeSkillPackagingConfig({ publish: false }, { linkFollowDepth: 2 }))).toBe(false);
  });

  it('lets the per-skill block win over the defaults, in both directions', () => {
    expect(isSkillPublished(mergeSkillPackagingConfig({ publish: false }, { publish: true }))).toBe(true);
    expect(isSkillPublished(mergeSkillPackagingConfig({ publish: true }, { publish: false }))).toBe(false);
    expect(isSkillPublished(mergeSkillPackagingConfig(undefined, { publish: false }))).toBe(false);
  });
});

describe('pluginLocalSkillConfigEntry', () => {
  const skill = { skillName: 'named', skillDirPath: 'group/leaf' };

  it('prefers the declared name, then the directory path, then its trailing segment', () => {
    expect(pluginLocalSkillConfigEntry({ named: 1, 'group/leaf': 2, leaf: 3 }, skill)).toBe(1);
    expect(pluginLocalSkillConfigEntry({ 'group/leaf': 2, leaf: 3 }, skill)).toBe(2);
    expect(pluginLocalSkillConfigEntry({ leaf: 3 }, skill)).toBe(3);
    expect(pluginLocalSkillConfigEntry({ other: 4 }, skill)).toBeUndefined();
    expect(pluginLocalSkillConfigEntry(undefined, skill)).toBeUndefined();
  });
});
