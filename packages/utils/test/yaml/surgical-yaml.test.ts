import { describe, expect, it } from 'vitest';

import { updateYamlIn, verifyConfinedYamlEdit } from '../../src/yaml.js';

describe('updateYamlIn — surgical scalar replace', () => {
  it('preserves inline trailing comment AND its alignment whitespace verbatim', () => {
    const before = 'model: haiku   # which model\n';
    const after = updateYamlIn(before, ['model'], 'opus');

    // The 3-space alignment gap and the comment must survive byte-for-byte.
    expect(after).toBe('model: opus   # which model\n');
    expect(() => verifyConfinedYamlEdit(before, after, [['model']])).not.toThrow();
  });

  it('leaves a comment-only line between two keys untouched', () => {
    const before = 'a: 1\n# between comment\nb: 2\n';
    const after = updateYamlIn(before, ['b'], 9);

    expect(after).toBe('a: 1\n# between comment\nb: 9\n');
    expect(() => verifyConfinedYamlEdit(before, after, [['b']])).not.toThrow();
  });

  it('preserves a head comment with a blank line above the key', () => {
    const before = 'a: 1\n\n# head for b\nb: 2\n';
    const after = updateYamlIn(before, ['b'], 'x');

    expect(after).toBe('a: 1\n\n# head for b\nb: x\n');
    expect(() => verifyConfinedYamlEdit(before, after, [['b']])).not.toThrow();
  });

  it('does not reflow an unpadded flow sequence on a sibling key', () => {
    const before = 'tags: ["a", "b"]\nname: old\n';
    const after = updateYamlIn(before, ['name'], 'new');

    // Must NOT become tags: [ "a", "b" ].
    expect(after).toBe('tags: ["a", "b"]\nname: new\n');
    expect(after).toContain('tags: ["a", "b"]');
    expect(() => verifyConfinedYamlEdit(before, after, [['name']])).not.toThrow();
  });

  it('does not wrap a long (>80 col) unwrapped scalar on a sibling key', () => {
    const longValue = 'a'.repeat(120);
    const before = `description: ${longValue}\nshort: x\n`;
    const after = updateYamlIn(before, ['short'], 'y');

    expect(after).toBe(`description: ${longValue}\nshort: y\n`);
    // The long line stays on a single physical line.
    expect(after).toContain(`description: ${longValue}\n`);
    expect(() => verifyConfinedYamlEdit(before, after, [['short']])).not.toThrow();
  });

  it('leaves anchors and aliases elsewhere in the document untouched', () => {
    const before = 'base: &b hello\nref: *b\ntarget: old\n';
    const after = updateYamlIn(before, ['target'], 'new');

    expect(after).toBe('base: &b hello\nref: *b\ntarget: new\n');
    expect(after).toContain('base: &b hello');
    expect(after).toContain('ref: *b');
    expect(() => verifyConfinedYamlEdit(before, after, [['target']])).not.toThrow();
  });

  it('leaves a block-literal scalar on a sibling key untouched', () => {
    const before = 'notes: |\n  line one\n  line two\nflag: false\n';
    const after = updateYamlIn(before, ['flag'], true);

    expect(after).toBe('notes: |\n  line one\n  line two\nflag: true\n');
    expect(() => verifyConfinedYamlEdit(before, after, [['flag']])).not.toThrow();
  });

  it('leaves a folded scalar on a sibling key untouched', () => {
    const before = 'summary: >\n  folded one\n  folded two\nflag: 1\n';
    const after = updateYamlIn(before, ['flag'], 2);

    expect(after).toBe('summary: >\n  folded one\n  folded two\nflag: 2\n');
    expect(() => verifyConfinedYamlEdit(before, after, [['flag']])).not.toThrow();
  });

  it('leaves a quoted key untouched when editing a sibling', () => {
    const before = '"my key": value\nother: 1\n';
    const after = updateYamlIn(before, ['other'], 2);

    expect(after).toBe('"my key": value\nother: 2\n');
    expect(after).toContain('"my key": value');
    expect(() => verifyConfinedYamlEdit(before, after, [['other']])).not.toThrow();
  });

  it('replaces a deeply nested scalar (skills.config.foo.test.model)', () => {
    const before = 'skills:\n  config:\n    foo:\n      test:\n        model: haiku\n';
    const path = ['skills', 'config', 'foo', 'test', 'model'];
    const after = updateYamlIn(before, path, 'opus');

    expect(after).toBe('skills:\n  config:\n    foo:\n      test:\n        model: opus\n');
    expect(() => verifyConfinedYamlEdit(before, after, [path])).not.toThrow();
  });

  it('serializes numeric, boolean and null replacement values as bare tokens', () => {
    expect(updateYamlIn('n: 1\n', ['n'], 42)).toBe('n: 42\n');
    expect(updateYamlIn('b: false\n', ['b'], true)).toBe('b: true\n');
    expect(updateYamlIn('x: hello\n', ['x'], null)).toBe('x: null\n');
  });

  it('quotes a replacement value when YAML requires it', () => {
    const before = 'greeting: hi\n';
    const after = updateYamlIn(before, ['greeting'], 'yes: no');

    // A bare `yes: no` would be ambiguous, so yaml must quote it.
    expect(after).not.toBe('greeting: yes: no\n');
    expect(after).toContain('greeting:');
    expect(() => verifyConfinedYamlEdit(before, after, [['greeting']])).not.toThrow();
  });

  it('does not wrap a long (>80 col) replacement string value (no-wrap path on replace branch)', () => {
    const longValue = 'b'.repeat(90);
    const before = 'description: short\n';
    const after = updateYamlIn(before, ['description'], longValue);

    // The replacement must land on a single line — lineWidth:0 must apply to the
    // REPLACE branch, not only when preserving siblings with long values.
    expect(after).toBe(`description: ${longValue}\n`);
    expect(() => verifyConfinedYamlEdit(before, after, [['description']])).not.toThrow();
  });
});

describe('updateYamlIn — surgical new-key insert (init case)', () => {
  it('inserts a new nested block into an existing populated map, leaving siblings byte-identical', () => {
    const keepLine = '      model: haiku   # keep me\n';
    const before = 'skills:\n  config:\n    foo:\n' + keepLine + '  other:\n    x: 1\n';
    const path = ['skills', 'config', 'foo', 'test', 'model'];
    const after = updateYamlIn(before, path, 'opus');

    expect(after).toBe(
      'skills:\n' +
        '  config:\n' +
        '    foo:\n' +
        keepLine +
        '      test:\n' +
        '        model: opus\n' +
        '  other:\n' +
        '    x: 1\n',
    );
    // The pre-existing sibling comment and the unrelated `other` block survive.
    expect(after).toContain('model: haiku   # keep me');
    expect(after).toContain('  other:\n    x: 1\n');
    expect(() => verifyConfinedYamlEdit(before, after, [path])).not.toThrow();
  });

  it('renders a plain document when inserting into an empty source', () => {
    const after = updateYamlIn('', ['a', 'b'], 'x');
    expect(after).toBe('a:\n  b: x\n');
  });
});

describe('updateYamlIn — type-mismatch guard', () => {
  it('throws rather than silently mangling a collection overwritten with a scalar', () => {
    const before = 'foo:\n  bar: 1\n';
    expect(() => updateYamlIn(before, ['foo'], 'oops')).toThrow(/collection/i);
  });

  it('throws on syntactically invalid YAML input', () => {
    // An unterminated flow sequence is a hard YAML parse error and must not
    // silently produce garbage — the parser should throw before any edit.
    expect(() => updateYamlIn('key: [unterminated', ['key'], 'val')).toThrow();
  });

  it('throws when attempting to insert under a path whose ancestor is a scalar, not a map', () => {
    // 'a' is a plain string scalar; descending into 'a.b' is impossible without
    // overwriting 'a' with a map, which the guard must reject.
    const before = 'a: hello\n';
    expect(() => updateYamlIn(before, ['a', 'b'], 'new')).toThrow();
  });
});

describe('updateYamlIn — EOL preservation', () => {
  it('round-trips a CRLF document with CRLF line endings', () => {
    const before = 'a: 1\r\nb: haiku\r\n';
    const after = updateYamlIn(before, ['b'], 'opus');

    expect(after).toBe('a: 1\r\nb: opus\r\n');
    expect(after).toContain('\r\n');
  });

  it('inserts a new block using CRLF endings in a CRLF document', () => {
    const before = 'skills:\r\n  foo:\r\n    model: haiku\r\n';
    const after = updateYamlIn(before, ['skills', 'foo', 'test', 'model'], 'opus');

    expect(after).toBe(
      'skills:\r\n  foo:\r\n    model: haiku\r\n    test:\r\n      model: opus\r\n',
    );
  });
});

describe('verifyConfinedYamlEdit — negative cases', () => {
  it('throws when a value outside changedPaths was also changed', () => {
    const before = 'a: 1\nb: 2\n';
    const after = 'a: 1\nb: 99\n';

    expect(() => verifyConfinedYamlEdit(before, after, [['a']])).toThrow(/confined|b/i);
  });

  it('throws when a comment was dropped', () => {
    const before = 'a: 1  # note\nb: 2\n';
    const after = 'a: 5\nb: 2\n';

    expect(() => verifyConfinedYamlEdit(before, after, [['a']])).toThrow(/comment/i);
  });

  it('throws when a claimed changed path did not land in after', () => {
    const before = 'a: 1\n';
    const after = 'a: 1\n';

    expect(() => verifyConfinedYamlEdit(before, after, [['nope']])).toThrow(/nope/i);
  });

  it('accepts a confined multi-byte edit with all comments preserved', () => {
    const before = 'a: 1  # one\nb: 2  # two\n';
    const after = 'a: 5  # one\nb: 2  # two\n';

    expect(() => verifyConfinedYamlEdit(before, after, [['a']])).not.toThrow();
  });
});
