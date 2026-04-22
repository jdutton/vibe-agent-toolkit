import { describe, expect, it } from 'vitest';

import { detectSkillCollisions, type SkillRef } from '../src/skill-collision.js';

function local(name: string, plugin: string): SkillRef {
  return {
    name,
    plugin,
    sourcePath: `plugins/${plugin}/skills/${name}/SKILL.md`,
  };
}

describe('detectSkillCollisions', () => {
  it('returns no collisions when all names are distinct', () => {
    const out = detectSkillCollisions([
      local('a', 'p1'),
      local('b', 'p1'),
      local('c', 'p2'),
    ]);
    expect(out).toEqual([]);
  });

  it('detects case-sensitive cross-plugin collision', () => {
    const out = detectSkillCollisions([local('foo', 'p1'), local('foo', 'p2')]);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('exact');
  });

  it('detects case-insensitive cross-plugin collision', () => {
    const out = detectSkillCollisions([local('Foo', 'p1'), local('foo', 'p2')]);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('case-insensitive');
  });

  it('does NOT flag same-plugin pairs (defensive guard; discovery prevents this)', () => {
    // Same plugin + same name should never arrive via normal discovery, but
    // the classifier returns undefined defensively rather than emitting noise.
    const out = detectSkillCollisions([local('foo', 'p1'), local('foo', 'p1')]);
    expect(out).toEqual([]);
  });

  it('returns resolution guidance with both paths and plugin names', () => {
    const out = detectSkillCollisions([local('foo', 'p1'), local('foo', 'p2')]);
    expect(out[0]?.message).toContain('plugins/p1/skills/foo/SKILL.md');
    expect(out[0]?.message).toContain('plugins/p2/skills/foo/SKILL.md');
    expect(out[0]?.message).toContain('p1');
    expect(out[0]?.message).toContain('p2');
  });
});
