import { describe, expect, it } from 'vitest';

import { matchesGlobPattern } from '../src/utils.js';

describe('matchesGlobPattern', () => {
  describe('basic glob matching', () => {
    it('matches files in a directory tree', () => {
      expect(matchesGlobPattern('/project/docs/README.md', 'docs/**')).toBe(true);
      expect(matchesGlobPattern('/project/docs/sub/x.md', 'docs/**')).toBe(true);
    });

    it('rejects files outside the pattern', () => {
      expect(matchesGlobPattern('/project/src/index.ts', 'docs/**')).toBe(false);
      expect(matchesGlobPattern('/project/src/index.ts', '*.md')).toBe(false);
    });

    it('matches by basename via matchBase fallback', () => {
      // Pattern with no directory component matches basename anywhere
      expect(matchesGlobPattern('/project/deep/path/to/README.md', '*.md')).toBe(true);
    });
  });

  // Behavior-contract guard: this function is used to filter resources by
  // glob in resource-query and resource-registry, and to match paths against
  // excludeReferencesFromBundle patterns in content-transform. Adopter paths
  // commonly traverse dotfile segments (.claude/, .worktrees/, .config/). The
  // function must match through them — its two-strategy approach handles this
  // via segment-walking (strategy 2), but the contract is worth pinning so
  // a future refactor doesn't silently drop the support.
  describe('dotfile-segment paths', () => {
    it('matches dotfile-prefixed directory segments via `docs/**`-style patterns', () => {
      // matchBase strategy handles `*.md` already; verify strategy-2 (path-segment
      // glob) handles dotfile traversal too.
      expect(matchesGlobPattern('/project/.claude/skills/foo/SKILL.md', 'skills/**')).toBe(true);
      expect(matchesGlobPattern('/project/.worktrees/wt1/packages/x.md', 'packages/**')).toBe(true);
      expect(matchesGlobPattern('/project/.config/agents/y.md', 'agents/**')).toBe(true);
    });

    it('matches dotfile-traversing paths via `**/*`-style patterns', () => {
      expect(matchesGlobPattern('/project/.claude/skills/foo/SKILL.md', '**/SKILL.md')).toBe(true);
      expect(matchesGlobPattern('/project/.worktrees/wt1/x.md', '**/*.md')).toBe(true);
    });
  });
});
