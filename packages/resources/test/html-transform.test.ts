import { describe, expect, it } from 'vitest';

import { parseHtmlDocument, walkElements } from '../src/html-link-parser.js';
import { rewriteHtmlLinks, type UnappliedRewrite } from '../src/html-transform.js';

const swap = (from: string, to: string) => (href: string) => (href === from ? to : href);

/** A valueless `href` attribute — has no value span, so a wanted rewrite cannot be applied. */
const VALUELESS_HREF = '<a href>x</a>';

/** Re-parse `html` and return the entity-decoded value of the first `<tag attr>`. */
function readAttr(html: string, tag: string, attr: string): string | undefined {
  const { document } = parseHtmlDocument(html);
  for (const el of walkElements(document)) {
    if (el.tagName !== tag) continue;
    const found = el.attrs.find((a) => a.name === attr);
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
