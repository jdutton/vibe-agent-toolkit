/**
 * The skill-text golden capture's root scrub, over the spellings a Windows run
 * hands it: the project root as `mkdirSyncReal` returns it (native backslashes)
 * beside the forward-slash paths every producer emits, a drive letter in the
 * other case, and a backslash path (which JSON escapes). Each is lexical, so the
 * case runs on every host.
 */

import { describe, expect, it } from 'vitest';

import { firstDifferingLine, scrubbed } from './helpers/skill-text-golden-capture.js';

/** A Windows run's two roots: the project as `mkdirSyncReal` spells it, and its scratch parent as `safePath.join` does. */
const PROJECT = String.raw`D:\a\repo\packages\cli\.test-output\integration\skill-text-golden-1-2\project`;
const SCRATCH = 'D:/a/repo/packages/cli/.test-output/integration/skill-text-golden-1-2';
const ROOTS = [PROJECT, SCRATCH] as const;

describe('the golden capture scrubs every spelling of its roots', () => {
  it('makes a forward-slash path under a native-spelled root relative to that root, not to its parent', () => {
    expect(scrubbed({ path: `${SCRATCH}/project/clean-skill/SKILL.md` }, ROOTS)).toEqual({ path: 'clean-skill/SKILL.md' });
  });

  it('makes a path relative whatever the case of its drive letter', () => {
    expect(scrubbed({ path: 'd:/a/repo/packages/cli/.test-output/integration/skill-text-golden-1-2/project/dup-a/SKILL.md' }, ROOTS))
      .toEqual({ path: 'dup-a/SKILL.md' });
  });

  it('strips a backslash root from a value JSON escapes, and keeps the native separators after it for the golden to catch', () => {
    expect(scrubbed({ file: String.raw`${PROJECT}\enc-bom\SKILL.md` }, ROOTS)).toEqual({ file: String.raw`enc-bom\SKILL.md` });
  });

  it('keeps a separator that does not match the root spelling it follows visible, for the golden to catch', () => {
    expect(scrubbed({ file: String.raw`${SCRATCH}/project\SKILL.md`, mixed: String.raw`${SCRATCH}/project\x/SKILL.md` }, ROOTS))
      .toEqual({ file: String.raw`.\SKILL.md`, mixed: String.raw`.\x/SKILL.md` });
    expect(scrubbed({ file: `${PROJECT}/SKILL.md` }, ROOTS)).toEqual({ file: './SKILL.md' });
  });

  it('makes a root embedded in a message relative, and the bare root "."', () => {
    expect(scrubbed([`see ${SCRATCH}/project/x/SKILL.md`, `${SCRATCH}/project`, `${SCRATCH}/cache/y`], ROOTS))
      .toEqual(['see x/SKILL.md', '.', 'cache/y']);
  });

  it('scrubs object keys too', () => {
    expect(scrubbed({ [`${SCRATCH}/project/x/SKILL.md`]: 1 }, ROOTS)).toEqual({ 'x/SKILL.md': 1 });
  });
});

describe('a golden mismatch names its first differing line', () => {
  it('names the line, what was expected and what was received', () => {
    expect(firstDifferingLine('{\n  "a": 1,\n  "b": 2\n}\n', '{\n  "a": 1,\n  "b": 3\n}\n'))
      .toBe(String.raw`golden line 3 differs: expected "  \"b\": 3" but received "  \"b\": 2"`);
  });

  it('names a line one side lacks', () => {
    expect(firstDifferingLine('a\n', 'a\nb\n')).toBe('golden line 2 differs: expected "b" but received ""');
    expect(firstDifferingLine('a\nb', 'a')).toBe('golden line 2 differs: expected (no line) but received "b"');
  });

  it('leads the failed assertion message, ahead of the truncated values', () => {
    const received = `${'x\n'.repeat(50)}y\n`;
    const expected = `${'x\n'.repeat(50)}z\n`;
    expect(() => expect(received, firstDifferingLine(received, expected)).toBe(expected))
      .toThrow(/^golden line 51 differs: expected "z" but received "y"/);
  });

  it('is undefined for identical text', () => {
    expect(firstDifferingLine('a\nb\n', 'a\nb\n')).toBeUndefined();
  });
});
