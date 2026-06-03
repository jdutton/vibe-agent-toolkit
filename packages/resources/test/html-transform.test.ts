import { describe, expect, it } from 'vitest';

import { rewriteHtmlLinks } from '../src/html-transform.js';

const swap = (from: string, to: string) => (href: string) => (href === from ? to : href);
const identity = (href: string): string => href;
const always = (value: string) => (): string => value;

interface RewriteCase {
  name: string;
  src: string;
  rewrite: (href: string) => string;
  expected: string;
}

describe('rewriteHtmlLinks', () => {
  // Table-driven so the repetitive arrange/act/assert shape lives in ONE body
  // (avoids structural duplication SonarCloud's CPD flags across near-identical
  // `it` blocks). Multi-rewrite drift is a distinct shape, kept separate below.
  const cases: readonly RewriteCase[] = [
    {
      name: 'returns byte-identical source when nothing changes',
      src: '<!doctype html>\n<a href="./a.html">x</a> <!-- keep -->\n<img src=\'b.png\'>',
      rewrite: identity,
      expected: '<!doctype html>\n<a href="./a.html">x</a> <!-- keep -->\n<img src=\'b.png\'>',
    },
    {
      name: 'rewrites only the targeted href, preserving double quotes',
      src: '<a href="./old.html" class="z">x</a>',
      rewrite: swap('./old.html', './new.html'),
      expected: '<a href="./new.html" class="z">x</a>',
    },
    {
      name: 'preserves single quotes',
      src: "<img src='one.png'>",
      rewrite: swap('one.png', 'two.png'),
      expected: "<img src='two.png'>",
    },
    {
      name: 'keeps unquoted values unquoted when safe',
      src: '<a href=bare.html>x</a>',
      rewrite: swap('bare.html', 'plain.html'),
      expected: '<a href=plain.html>x</a>',
    },
    {
      name: 'adds quotes to a previously-unquoted value only when unsafe',
      src: '<a href=spacey.html>x</a>',
      rewrite: swap('spacey.html', 'new file.html'),
      expected: '<a href="new file.html">x</a>',
    },
    {
      name: 'escapes & and the active double quote in the written value',
      src: '<a href="dq">x</a>',
      rewrite: swap('dq', 'a&b"c'),
      expected: '<a href="a&amp;b&quot;c">x</a>',
    },
    {
      name: 'escapes & and the active single quote',
      src: "<img src='sq.png'>",
      rewrite: swap('sq.png', "a'b&c"),
      expected: "<img src='a&#39;b&amp;c'>",
    },
    {
      name: 'handles whitespace around the = sign',
      src: '<a href = "spaced.html">x</a>',
      rewrite: swap('spaced.html', 'tightened.html'),
      expected: '<a href = "tightened.html">x</a>',
    },
    {
      name: 'ignores <a> elements that have no href attribute',
      src: '<a name="anchor">x</a><a href="noattr.html">y</a>',
      rewrite: swap('noattr.html', 'linked.html'),
      expected: '<a name="anchor">x</a><a href="linked.html">y</a>',
    },
    {
      name: 'leaves a valueless (boolean) attribute untouched',
      src: '<a href>x</a>',
      rewrite: always('changed'),
      expected: '<a href>x</a>',
    },
    {
      name: 'leaves an empty-value attribute (href=) untouched',
      src: '<a href=>x</a>',
      rewrite: always('changed'),
      expected: '<a href=>x</a>',
    },
  ];

  it.each(cases)('$name', ({ src, rewrite, expected }) => {
    expect(rewriteHtmlLinks(src, rewrite)).toBe(expected);
  });

  it('applies multiple rewrites without offset drift', () => {
    const src = '<a href="a.html">1</a><a href="b.html">2</a>';
    const mapping: Record<string, string> = { 'a.html': 'x.html', 'b.html': 'y.html' };
    const rw = (h: string) => mapping[h] ?? h;
    expect(rewriteHtmlLinks(src, rw)).toBe('<a href="x.html">1</a><a href="y.html">2</a>');
  });
});
