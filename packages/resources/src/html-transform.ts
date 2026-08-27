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
 *
 * Non-goal: `<base href>` is not honored. Relative hrefs are resolved by the
 * caller against the file's own directory; a `<base>` element that would
 * override that in a browser is ignored.
 */

import { findAttr, parseHtmlDocument, sourceSpelling, walkElements } from './html-link-parser.js';
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

/** A wanted link rewrite that could not be spliced back into the source. */
export interface UnappliedRewrite {
  tagName: string;
  /**
   * The attribute's **source spelling** (`sourceSpelling`), so a namespaced
   * attribute is reported as the author wrote it — `xlink:href`, not the bare
   * `href` the tag→attribute table looked it up by. Identical to that table's
   * literal for every un-prefixed attribute, which is every HTML-namespace one.
   */
  attr: string;
  /** The original attribute value the rewrite targeted. */
  from: string;
  /** The value the rewrite wanted to write. */
  to: string;
  /**
   * Why the splice could not be located:
   * - `no-source-location` — parse5 omitted the attribute's offsets (synthesized
   *   during error recovery on malformed input).
   * - `unparseable-attribute` — the attribute's source span had no locatable
   *   value (e.g. an unterminated quote).
   */
  reason: 'no-source-location' | 'unparseable-attribute';
}

/**
 * Rewrite `<a href>` / `<img src>` values in `source` using `rewriteHref`.
 * Returns `source` unchanged (byte-for-byte) when no value changes.
 *
 * A rewrite that is wanted (the href resolves to a new value) but cannot be
 * spliced back — because parse5 omitted the source location or the attribute
 * span is unparseable — is reported via `onUnapplied` rather than dropped
 * silently. Malformed pages are exactly the ones that hit this path, so the
 * caller can surface it instead of shipping a stale link.
 */
export function rewriteHtmlLinks(
  source: string,
  rewriteHref: RewriteHref,
  onUnapplied?: (info: UnappliedRewrite) => void,
): string {
  const { document } = parseHtmlDocument(source);
  const edits: Edit[] = [];

  for (const element of walkElements(document)) {
    const attrName = LINK_ATTR_BY_TAG[element.tagName];
    if (attrName === undefined) {
      continue;
    }
    const attr = findAttr(element, attrName);
    if (attr === undefined) {
      continue;
    }
    // Resolve first so we only record drops that actually lose a wanted edit.
    const newValue = rewriteHref(attr.value);
    if (newValue === attr.value) {
      continue;
    }
    // ⛔ Keyed on the MATCHED attribute's source spelling, never on `attrName`.
    // `findAttr` matches a namespaced `xlink:href` on its bare local name, but
    // parse5 files the span under `'xlink:href'` — so the hardcoded literal
    // missed, this took the `no-source-location` branch, and the rewrite was
    // dropped from a page that parsed cleanly. See `sourceSpelling`.
    const spelling = sourceSpelling(attr);
    const location = element.sourceCodeLocation?.attrs?.[spelling];
    if (location === undefined) {
      onUnapplied?.({ tagName: element.tagName, attr: spelling, from: attr.value, to: newValue, reason: 'no-source-location' });
      continue;
    }
    const span = valueSpan(source.slice(location.startOffset, location.endOffset), location.startOffset);
    if (span === undefined) {
      onUnapplied?.({ tagName: element.tagName, attr: spelling, from: attr.value, to: newValue, reason: 'unparseable-attribute' });
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
