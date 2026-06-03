/**
 * Structure-preserving HTML link rewriter.
 *
 * Rewrites `<a href>` and `<img src>` attribute VALUES in place by splicing the
 * original source string at parse5-reported offsets. The document is never
 * re-serialized (parse5's serializer normalizes whitespace, quotes, void
 * elements, and the doctype), so unchanged input round-trips byte-for-byte.
 *
 * Uses the same `RewriteHref` callback model as `rewriteBodyLinks` — callers
 * supply per-href target resolution; this module owns only the splice mechanics.
 */

import { parseHtmlDocument, walkElements } from './html-link-parser.js';
import type { RewriteHref } from './rewriter-helpers.js';

/** Tag name → the single link-bearing attribute we rewrite. */
const LINK_ATTR_BY_TAG: Record<string, string | undefined> = { a: 'href', img: 'src' };

interface ValueSpan {
  valueStart: number;
  valueEnd: number;
  /** `"` or `'` for quoted attributes; `''` for unquoted. */
  quote: string;
}

interface Edit extends ValueSpan {
  newValue: string;
}

/**
 * Chars that force an unquoted HTML attribute value to be quoted. Follows the
 * WHATWG unquoted-attribute-value rules: whitespace, quotes, `<`, `>`, plus
 * backtick and `=` (a superset of paths we expect, kept strict for safety).
 */
const UNQUOTED_UNSAFE = /[\s"'`<>=]/;

/**
 * Locate the value sub-range within an attribute's full source span.
 *
 * parse5 reports the whole-attribute span (`href="value"`); this finds the
 * value's absolute offsets and the quote char. Returns undefined for boolean
 * attributes (no `=`).
 */
function valueSpan(attrSource: string, base: number): ValueSpan | undefined {
  const eq = attrSource.indexOf('=');
  if (eq === -1) {
    return undefined;
  }
  let i = eq + 1;
  while (i < attrSource.length && /\s/.test(attrSource.charAt(i))) {
    i += 1;
  }
  if (i >= attrSource.length) {
    return undefined;
  }
  const ch = attrSource.charAt(i);
  if (ch === '"' || ch === "'") {
    const close = attrSource.indexOf(ch, i + 1);
    const end = close === -1 ? attrSource.length : close;
    return { valueStart: base + i + 1, valueEnd: base + end, quote: ch };
  }
  return { valueStart: base + i, valueEnd: base + attrSource.length, quote: '' };
}

/**
 * Encode a new value for writing. For quoted attributes the surrounding quotes
 * stay in the source (we only replace the inner value), so we escape `&` and the
 * active quote. For originally-unquoted values we keep them bare when safe, else
 * wrap in double quotes.
 */
function encodeValue(newValue: string, quote: string): string {
  if (quote === '"' || quote === "'") {
    const amp = newValue.replaceAll('&', '&amp;');
    return quote === '"' ? amp.replaceAll('"', '&quot;') : amp.replaceAll("'", '&#39;');
  }
  if (newValue.length > 0 && !UNQUOTED_UNSAFE.test(newValue)) {
    return newValue.replaceAll('&', '&amp;');
  }
  const escaped = newValue.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  return `"${escaped}"`;
}

/**
 * Rewrite `<a href>` / `<img src>` values in `source` using `rewriteHref`.
 * Returns `source` unchanged (byte-for-byte) when no value changes.
 */
export function rewriteHtmlLinks(source: string, rewriteHref: RewriteHref): string {
  const { document } = parseHtmlDocument(source);
  const edits: Edit[] = [];

  for (const element of walkElements(document)) {
    const attrName = LINK_ATTR_BY_TAG[element.tagName];
    if (attrName === undefined) {
      continue;
    }
    const attr = element.attrs.find((a) => a.name === attrName);
    if (attr === undefined) {
      continue;
    }
    const location = element.sourceCodeLocation?.attrs?.[attrName];
    if (location === undefined) {
      continue;
    }
    const newValue = rewriteHref(attr.value);
    if (newValue === attr.value) {
      continue;
    }
    const span = valueSpan(source.slice(location.startOffset, location.endOffset), location.startOffset);
    if (span === undefined) {
      continue;
    }
    edits.push({ ...span, newValue });
  }

  // Apply descending by start offset so earlier edits don't shift later ones.
  edits.sort((a, b) => b.valueStart - a.valueStart);
  let result = source;
  for (const edit of edits) {
    result = result.slice(0, edit.valueStart) + encodeValue(edit.newValue, edit.quote) + result.slice(edit.valueEnd);
  }
  return result;
}
