import { describe, expect, it } from 'vitest';

import { findAttr, parseHtmlDocument, walkElements } from '../src/html-link-parser.js';
import { rewriteHtmlLinks, type UnappliedRewrite } from '../src/html-transform.js';

const swap = (from: string, to: string) => (href: string) => (href === from ? to : href);

/** A valueless `href` attribute — has no value span, so a wanted rewrite cannot be applied. */
const VALUELESS_HREF = '<a href>x</a>';

/** Re-parse `html` and return the entity-decoded value of the first `<tag attr>`. */
function readAttr(html: string, tag: string, attr: string): string | undefined {
  const { document } = parseHtmlDocument(html);
  for (const el of walkElements(document)) {
    if (el.tagName !== tag) continue;
    const found = findAttr(el, attr);
    if (found) return found.value;
  }
  return undefined;
}

describe('rewriteHtmlLinks', () => {
  it('returns byte-identical source when nothing changes', () => {
    const src = '<!doctype html>\n<a href="./a.html">x</a> <!-- keep -->\n<img src=\'b.png\'>';
    expect(rewriteHtmlLinks(src, (h) => h)).toBe(src);
  });

  it('rewrites only the targeted href, preserving double quotes', () => {
    const src = '<a href="./old.html" class="z">x</a>';
    expect(rewriteHtmlLinks(src, swap('./old.html', './new.html'))).toBe(
      '<a href="./new.html" class="z">x</a>',
    );
  });

  it('preserves single quotes', () => {
    const src = "<img src='old.png'>";
    expect(rewriteHtmlLinks(src, swap('old.png', 'new.png'))).toBe("<img src='new.png'>");
  });

  it('keeps unquoted values unquoted when safe', () => {
    const src = '<a href=old.html>x</a>';
    expect(rewriteHtmlLinks(src, swap('old.html', 'new.html'))).toBe('<a href=new.html>x</a>');
  });

  it('adds quotes to a previously-unquoted value only when unsafe', () => {
    const src = '<a href=old.html>x</a>';
    expect(rewriteHtmlLinks(src, swap('old.html', 'new file.html'))).toBe(
      '<a href="new file.html">x</a>',
    );
  });

  it('escapes & and the active quote in the written value', () => {
    const src = '<a href="old">x</a>';
    expect(rewriteHtmlLinks(src, swap('old', 'a&b"c'))).toBe('<a href="a&amp;b&quot;c">x</a>');
  });

  it('applies multiple rewrites without offset drift', () => {
    const src = '<a href="a.html">1</a><a href="b.html">2</a>';
    const mapping: Record<string, string> = { 'a.html': 'x.html', 'b.html': 'y.html' };
    const rw = (h: string) => mapping[h] ?? h;
    expect(rewriteHtmlLinks(src, rw)).toBe('<a href="x.html">1</a><a href="y.html">2</a>');
  });

  // Grouped into one block on purpose: a run of near-identical single-assertion
  // `it` blocks trips SonarCloud's copy-paste detector (it normalizes literals,
  // so varying the fixtures doesn't help). One multi-assertion body covers the
  // remaining valueSpan/encodeValue edge branches without that repetition.
  it('handles attribute-shape edge cases', () => {
    // Single-quote attribute: escape & and the active single quote.
    expect(rewriteHtmlLinks("<img src='q.png'>", swap('q.png', "a'b&c"))).toBe(
      "<img src='a&#39;b&amp;c'>",
    );
    // Whitespace around the = sign is preserved; only the value is spliced.
    expect(rewriteHtmlLinks('<a href = "ws.html">x</a>', swap('ws.html', 'done.html'))).toBe(
      '<a href = "done.html">x</a>',
    );
    // An <a> without an href attribute is skipped; a later real href still rewrites.
    expect(
      rewriteHtmlLinks('<a name="anchor">x</a><a href="real.html">y</a>', swap('real.html', 'out.html')),
    ).toBe('<a name="anchor">x</a><a href="out.html">y</a>');
    // Valueless and empty-value attributes have no value span to rewrite.
    expect(rewriteHtmlLinks(VALUELESS_HREF, () => 'changed')).toBe(VALUELESS_HREF);
    expect(rewriteHtmlLinks('<a href=>x</a>', () => 'changed')).toBe('<a href=>x</a>');
  });

  it('reports a wanted rewrite it cannot apply instead of dropping it silently', () => {
    const unapplied: UnappliedRewrite[] = [];
    // The rewrite is wanted (-> 'changed') but cannot be applied, so it must be recorded.
    const out = rewriteHtmlLinks(VALUELESS_HREF, () => 'changed', (info) => unapplied.push(info));
    expect(out).toBe(VALUELESS_HREF); // still byte-for-byte unchanged
    expect(unapplied).toHaveLength(1);
    expect(unapplied[0]).toMatchObject({ tagName: 'a', attr: 'href', to: 'changed', reason: 'unparseable-attribute' });
  });

  it('does not report when no rewrite is wanted', () => {
    const unapplied: UnappliedRewrite[] = [];
    rewriteHtmlLinks(VALUELESS_HREF, (h) => h, (info) => unapplied.push(info));
    expect(unapplied).toHaveLength(0);
  });

  /**
   * parse5 splits a namespaced attribute into `{ prefix: 'xlink', name: 'href' }`
   * but keys `sourceCodeLocation.attrs` under the **undivided source spelling**
   * `xlink:href` (measured, all three shapes below). So a finder on `attr.name`
   * MATCHES while a location lookup on the same bare `'href'` MISSES — the
   * rewriter then took its `no-source-location` branch and the href rewrite was
   * dropped silently, on a page that parses cleanly.
   *
   * Asserted on the FULL rewritten source, never on "it didn't throw": the
   * defect never threw. Only "the new value is actually in the output" can tell
   * the fix from the bug.
   */
  it('rewrites a namespaced href in SVG, MathML, and the uppercase spelling', () => {
    // Table rather than one `it` per row: near-identical single-assertion
    // blocks trip the copy-paste detector (see 'handles attribute-shape edge
    // cases' above). Each row differs in the axis under test — foreign-content
    // namespace and source casing — and shares nothing else.
    const cases: ReadonlyArray<readonly [string, string]> = [
      [
        '<svg><a xlink:href="./icon.md"><text>i</text></a></svg>',
        '<svg><a xlink:href="./icon.html"><text>i</text></a></svg>',
      ],
      ['<math><a xlink:href="./icon.md">m</a></math>', '<math><a xlink:href="./icon.html">m</a></math>'],
      // Casing of the SOURCE is preserved: parse5 folds only the location key.
      [
        '<svg><a XLINK:HREF="./icon.md"><text>u</text></a></svg>',
        '<svg><a XLINK:HREF="./icon.html"><text>u</text></a></svg>',
      ],
    ];

    for (const [source, expected] of cases) {
      expect(rewriteHtmlLinks(source, swap('./icon.md', './icon.html'))).toBe(expected);
    }
  });

  it('reports nothing unapplied for a namespaced href it can locate', () => {
    // The complement of the assertion above: a regression that reintroduced the
    // bare-literal key would show up here as a `no-source-location` report,
    // naming the mechanism rather than just an unequal string.
    const unapplied: UnappliedRewrite[] = [];
    const source = '<svg><a xlink:href="./ns.md">n</a></svg>';

    expect(rewriteHtmlLinks(source, swap('./ns.md', './ns.html'), (info) => unapplied.push(info))).toBe(
      '<svg><a xlink:href="./ns.html">n</a></svg>',
    );
    expect(unapplied).toEqual([]);
  });

  it('round-trips: the rewritten value decodes back to the exact target (no double-escape)', () => {
    // Splicing escapes `&` and the active quote into the source; a correct
    // implementation means a browser/parser decodes the value back to the
    // intended target verbatim. `a&b` vs `a&amp;b` are the double-escape canary.
    for (const target of ['a&b', 'a&amp;b', 'a"b', "a'b", 'x?y=1&z=2', 'plain.html']) {
      const out = rewriteHtmlLinks('<a href="old">x</a>', swap('old', target));
      expect(readAttr(out, 'a', 'href')).toBe(target);
    }
  });
});
