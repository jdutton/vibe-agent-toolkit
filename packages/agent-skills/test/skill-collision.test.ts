import { describe, expect, it } from 'vitest';

import { detectSkillCollisions, type SkillRef } from '../src/skill-collision.js';

function pool(name: string): SkillRef {
  return { name, origin: 'pool', sourcePath: `skills/${name}/SKILL.md` };
}
function local(name: string, plugin: string): SkillRef {
  return {
    name,
    origin: 'plugin-local',
    plugin,
    sourcePath: `plugins/${plugin}/skills/${name}/SKILL.md`,
  };
}

describe('detectSkillCollisions', () => {
  it('returns no collisions when all names are distinct', () => {
    const out = detectSkillCollisions([pool('a'), pool('b'), local('c', 'p1')]);
    expect(out).toEqual([]);
  });

  it('detects case-sensitive collision within one plugin selection set', () => {
    const out = detectSkillCollisions([pool('foo'), local('foo', 'p1')]);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('exact');
    expect(out[0]?.plugin).toBe('p1');
  });

  it('detects case-insensitive collision within one plugin selection set', () => {
    const out = detectSkillCollisions([pool('Foo'), local('foo', 'p1')]);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('case-insensitive');
  });

  it('allows the same plugin-local name across two different plugins', () => {
    const out = detectSkillCollisions([local('helper', 'p1'), local('helper', 'p2')]);
    expect(out).toEqual([]);
  });

  it('returns resolution guidance with both paths', () => {
    const out = detectSkillCollisions([pool('foo'), local('foo', 'p1')]);
    expect(out[0]?.message).toContain('skills/foo/SKILL.md');
    expect(out[0]?.message).toContain('plugins/p1/skills/foo/SKILL.md');
  });
});
