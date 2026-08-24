/**
 * HTML resource parser.
 *
 * Parses local HTML files into the shared `ParseResult` shape:
 * - `<a href>` and `<img src>` links (classified by `classifyLink`)
 * - `id` / `name` attributes as fragment anchors
 * - well-formedness diagnostics from parse5's `onParseError`
 *
 * Uses parse5 (WHATWG-conformant). The parse5 document + element walker are
 * exported so the link rewriter (html-transform.ts) shares one parser path.
 *
 * Non-goal: `<base href>` is not honored — relative links are resolved against
 * the file's own directory, not a document base.
 */

import { stat } from 'node:fs/promises';

import { readTextContent } from '@vibe-agent-toolkit/utils/fs';
import { parse, type DefaultTreeAdapterMap } from 'parse5';

import { classifyLink, estimateTokens } from './link-classify.js';
import type { ParseResult } from './link-parser.js';
import {
  ParsePass,
  ParserKind,
  parseTimingStart,
  recordParsedDocument,
  recordParsePass,
} from './parse-timing.js';
import { measureContent } from './projection/blob-facts.js';
import type { HtmlParseError } from './schemas/resource-metadata.js';
import type { ResourceLink } from './types.js';

type P5Node = DefaultTreeAdapterMap['node'];
type P5Element = DefaultTreeAdapterMap['element'];
type P5ChildNode = DefaultTreeAdapterMap['childNode'];

/** A parsed parse5 document together with any well-formedness diagnostics. */
export interface HtmlDocument {
  document: DefaultTreeAdapterMap['document'];
  parseErrors: HtmlParseError[];
}

/**
 * Parse an HTML source string with source-location info and collect parser
 * errors. Shared by `parseHtml` (link/anchor extraction) and `rewriteHtmlLinks`
 * (attribute offset splicing).
 */
export function parseHtmlDocument(source: string): HtmlDocument {
  const parseErrors: HtmlParseError[] = [];
  const document = parse(source, {
    sourceCodeLocationInfo: true,
    onParseError: (err) => {
      // parse5's ParserError extends Location which always has startLine: number.
      // We always include line since it is always present.
      parseErrors.push({ message: err.code, line: err.startLine });
    },
  });
  return { document, parseErrors };
}

/**
 * Depth-first walk yielding every element node in the tree.
 *
 * Deliberate gap: a `<template>` element's content lives in its separate
 * `content` fragment (not `childNodes`), so links inside `<template>` are not
 * walked, and foreign-content (SVG/MathML) subtrees are not special-cased.
 * Both are rare in the content link graph we rewrite.
 */
export function* walkElements(node: P5Node): Generator<P5Element> {
  if ('tagName' in node) {
    yield node;
  }
  if ('childNodes' in node) {
    for (const child of node.childNodes as P5ChildNode[]) {
      yield* walkElements(child);
    }
  }
}

function getAttr(element: P5Element, name: string): string | undefined {
  return element.attrs.find((a) => a.name === name)?.value;
}

function makeLink(href: string, line: number | undefined): ResourceLink {
  return { text: '', href, type: classifyLink(href), ...(line !== undefined && { line }) };
}

function visitElement(
  element: P5Element,
  links: ResourceLink[],
  anchors: Set<string>,
): void {
  const line = element.sourceCodeLocation?.startLine;

  if (element.tagName === 'a') {
    const href = getAttr(element, 'href');
    if (href !== undefined) {
      links.push(makeLink(href, line));
    }
    const name = getAttr(element, 'name');
    if (name !== undefined && name !== '') {
      anchors.add(name);
    }
  } else if (element.tagName === 'img') {
    const src = getAttr(element, 'src');
    if (src !== undefined) {
      links.push(makeLink(src, line));
    }
  }

  const id = getAttr(element, 'id');
  if (id !== undefined && id !== '') {
    anchors.add(id);
  }
}

/**
 * Parse HTML source text into a `ParseResult`.
 *
 * This is the content-addressable half of `parseHtml`: a pure function of its
 * two arguments with no filesystem access, no path handling and no I/O, so the
 * same `(content, sizeBytes)` pair always yields the same result and callers may
 * cache it keyed on the content.
 *
 * `sizeBytes` is a **parameter rather than something derived from `content`**
 * because the two are not interchangeable. The on-disk byte count
 * (`stat().size`) is what reaches packaged output; `Buffer.byteLength(content)`
 * and `content.length` are computed from the *decoded* string and diverge from
 * it on malformed UTF-8 (lone surrogates decode to U+FFFD, changing the byte
 * count). Making it a parameter keeps the choice of authority with the caller
 * that actually has the file — see `parseHtml`, which passes `stat().size`.
 *
 * @param content - The HTML source text.
 * @param sizeBytes - Byte size to report; the caller owns where it comes from.
 */
export function parseHtmlContent(content: string, sizeBytes: number): ParseResult {
  // Every `passStartedAt` / `recordParsePass` pair is the sub-phase timing seam
  // (`parse-timing.ts`), off unless `VAT_PARSE_TIMING` names a dump directory.
  // This parser reports into its OWN group with its OWN passes — an HTML-heavy
  // tree must not be described by markdown's pass list, and the two share a pass
  // name only where they genuinely run the same operation.
  const totalStartedAt = parseTimingStart();

  let passStartedAt = parseTimingStart();
  const { document, parseErrors } = parseHtmlDocument(content);
  recordParsePass(ParsePass.HtmlParse, passStartedAt);

  const links: ResourceLink[] = [];
  const anchors = new Set<string>();

  // ONE walk: the generator and the per-element visit are inseparable in the
  // cost sense, so they are bracketed together rather than pretending the
  // traversal and the extraction are separable passes.
  passStartedAt = parseTimingStart();
  for (const element of walkElements(document)) {
    visitElement(element, links, anchors);
  }
  recordParsePass(ParsePass.HtmlElementWalk, passStartedAt);

  const anchorList = [...anchors];

  // Hoisted out of the object literal below purely so they can be bracketed;
  // both are pure, so the order they run in is not observable.
  passStartedAt = parseTimingStart();
  const estimatedTokenCount = estimateTokens(content);
  recordParsePass(ParsePass.HtmlEstimateTokens, passStartedAt);

  // No fences: HTML has no fenced-code construct, so an HTML blob is all prose.
  // This is a modelling choice, not a stub — `<pre><code>` is markup with no
  // offset range the parse5 tree exposes as "code context", and treating a
  // `<pre>` block as code would need a second, HTML-specific definition of the
  // column that markdown's `code` nodes already define.
  passStartedAt = parseTimingStart();
  const contentMeasures = measureContent(content, []);
  recordParsePass(ParsePass.HtmlMeasureContent, passStartedAt);

  const result: ParseResult = {
    links,
    headings: [],
    content,
    sizeBytes,
    estimatedTokenCount,
    contentMeasures,
    ...(anchorList.length > 0 && { anchors: anchorList }),
    ...(parseErrors.length > 0 && { parseErrors }),
  };

  recordParsedDocument(ParserKind.Html, sizeBytes);
  recordParsePass(ParsePass.HtmlTotal, totalStartedAt);

  return result;
}

/**
 * Parse an HTML file into a `ParseResult`.
 *
 * @param filePath - Absolute path to the HTML file.
 */
export async function parseHtml(filePath: string): Promise<ParseResult> {
  // `readTextContent`, never `readFile(path, 'utf-8')`: this reads a CORPUS
  // document, whose encoding VAT does not choose. See text-content.ts.
  const [decoded, stats] = await Promise.all([
    readTextContent(filePath),
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is a user-provided path parameter
    stat(filePath),
  ]);

  return parseHtmlContent(decoded.text, stats.size);
}
