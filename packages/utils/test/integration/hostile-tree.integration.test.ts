/**
 * The shared hostile fixture: every field is what its doc says, `null` only
 * where the host cannot build the shape, and `cleanup` leaves nothing behind
 * — including the mode-000 directory a plain `rm -rf` cannot enter.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { relativeEscapesRoot, safePath } from '../../src/path-utils.js';
import { symlinkCapability } from '../../src/test-helpers.js';
import { HOSTILE_NAMES, type HostileTree, type HostileTreePerTest, hostileTreePerTest } from '../../src/testing/hostile-tree.js';
import { CANNOT_DENY_READS } from '../../src/testing/platform-gates.js';

describe('buildHostileTree', () => {
  const hostile: HostileTreePerTest = hostileTreePerTest('hostile-tree-');
  beforeEach(hostile.plant);
  afterEach(hostile.clear);
  const tree = (): HostileTree => hostile.tree();

  it('plants the root, a member, a dot-dot-named member, and the victim outside', () => {
    expect(lstatSync(tree().root).isDirectory()).toBe(true);
    expect(lstatSync(tree().member).isDirectory()).toBe(true);
    expect(safePath.relative(tree().root, tree().dotdotNamed)).toBe('..cache');
    expect(relativeEscapesRoot(safePath.relative(tree().root, tree().victim))).toBe(true);
    expect(readFileSync(safePath.join(tree().victim, 'secret.txt'), 'utf8')).toContain('TOKEN=');
  });

  it('answers the symlink fields exactly as the capability probe does', () => {
    const can = symlinkCapability() !== null;
    for (const link of [tree().linkOut, tree().linkIn, tree().dangling, tree().linkLoop, tree().rootAlias]) {
      expect(link === null).toBe(!can);
      if (link !== null) expect(lstatSync(link).isSymbolicLink()).toBe(true);
    }
    if (tree().linkOut !== null) expect(existsSync(safePath.join(tree().linkOut, 'secret.txt'))).toBe(true);
    if (tree().dangling !== null) expect(existsSync(tree().dangling)).toBe(false);
    // The loop resolves to the root: following it re-enters the tree.
    if (tree().linkLoop !== null) expect(existsSync(safePath.join(tree().linkLoop, 'loop', 'member', 'file.txt'))).toBe(true);
  });

  it('answers the unreadable field exactly as the read-denial gate does', () => {
    expect(tree().unreadable === null).toBe(CANNOT_DENY_READS);
    if (tree().unreadable !== null) {
      expect(() => readdirSync(tree().unreadable as string)).toThrow(/EACCES/);
    }
  });

  it('cleans up completely, twice, mode-000 directory included', () => {
    tree().cleanup();
    tree().cleanup();
    expect(existsSync(tree().root)).toBe(false);
    expect(existsSync(tree().outside)).toBe(false);
    if (tree().rootAlias !== null) expect(lstatSync.bind(null, tree().rootAlias)).toThrow(/ENOENT/);
  });

  it('carries a NUL-bearing name, so a sink test reaches the OS refusal too', () => {
    expect(HOSTILE_NAMES.some((name) => name.includes(String.fromCodePoint(0)))).toBe(true);
    expect(HOSTILE_NAMES).toContain('../victim');
  });
});
