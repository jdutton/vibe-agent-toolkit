/**
 * Characterization tests for the markdown link-rewriting divergence.
 *
 * ⚠️ THESE PIN CURRENT BEHAVIOUR, AND ONE ARM OF IT IS WRONG. They exist because
 * the divergence was found on 2026-09-04, recorded in prose in both modules'
 * docstrings, and then sat for two days with **both suites green** — nothing
 * mechanical read the prose. A defect that no test can see is free to get worse,
 * and a second grammar had already appeared without anyone noticing.
 *
 * What is actually wrong, and what "fixed" looks like, is stated per test. Do NOT
 * "fix" a failure here by editing the expectation: a change in these values means
 * a grammar moved, which is exactly the event this file exists to surface.
 *
 * ## The three grammars
 *
 * There are THREE link-matching regexes in the toolkit, not the two the docstrings
 * name. The third lives in `packages/agent-skills/src/post-build-checks.ts`
 * (`/(?<!\[)\[(?:[^\]\\]|\\.)*\]\(([^)]*)\)/g`) and is not exercised here because
 * it is in another package; it differs from BOTH of these by honouring `\]`
 * escapes. Recorded so the next reader does not rediscover it as "the second one".
 */

import { describe, expect, it } from 'vitest';

import { transformContent } from '../src/content-transform.js';
import { parseMarkdownContent } from '../src/link-parser.js';
import { rewriteBodyLinks } from '../src/rewriter-helpers.js';

/** An image nested inside a link — ordinary markdown, e.g. a badge linking somewhere. */
const IMAGE_IN_LINK = '[![alt](img.png)](url)';
/** The control: a plain link, on which every grammar agrees. */
const PLAIN_LINK = '[plain](plain.md)';

const PREFIX = 'REWRITTEN/';
const PASSTHROUGH_TEMPLATE = '[{{link.rawText}}](REWRITTEN/{{link.href}})';

function parseLinks(markdown: string) {
  return parseMarkdownContent(`${markdown}\n`, Buffer.byteLength(markdown) + 1).links;
}

function transform(markdown: string): string {
  return transformContent(markdown, parseLinks(markdown), {
    linkRewriteRules: [],
    defaultTemplate: PASSTHROUGH_TEMPLATE,
    context: {},
  });
}

describe('link grammar divergence — the parsed view', () => {
  it('reports ONE link for an image inside a link, and it is the OUTER one', () => {
    const links = parseLinks(IMAGE_IN_LINK);

    // This is the root cause of everything below. mdast yields a single `link`
    // node whose href is the OUTER target; the image is not a ResourceLink at
    // all (`LinkNodeType` has no `image` member — images are a *span kind*, used
    // for masking). Both rewriter regexes, meanwhile, match the INNER href.
    // The parsed view and the regex view therefore name DIFFERENT hrefs.
    expect(links).toHaveLength(1);
    expect(links[0]?.href).toBe('url');
    expect(links[0]?.nodeType).toBe('link');

    // Image `alt` is excluded from rendered link text, so there is no text to
    // re-emit either.
    expect(links[0]?.text).toBe('');

    // 🔑 The span covers the WHOLE construct, not just the href. That is what
    // makes a row-driven rewrite possible: a fix can splice [start, end) and get
    // the nesting right, where a regex replay cannot.
    expect(links[0]?.startOffset).toBe(0);
    expect(links[0]?.endOffset).toBe(IMAGE_IN_LINK.length);
  });

  it('reports NO link for a bare image', () => {
    // Consequence of the same design: an image href is invisible to link
    // rewriting outright, so a packaged image path is never rewritten.
    expect(parseLinks('![solo](solo.png)')).toHaveLength(0);
  });
});

describe('link grammar divergence — the two rewriters', () => {
  it('agrees on a plain link', () => {
    const expected = '[plain](REWRITTEN/plain.md)';
    expect(transform(PLAIN_LINK)).toBe(expected);
    expect(rewriteBodyLinks(PLAIN_LINK, (href) => `${PREFIX}${href}`)).toBe(expected);
  });

  it('DISAGREES on an image inside a link — and transformContent silently does nothing', () => {
    // ❌ WRONG, and the reason this file exists. `transformContent` replays its
    // regex, gets href `img.png`, looks that up in the href→ResourceLink map
    // built from the parsed links (which holds only `url`), misses, and takes
    // its "link not in the parsed links array — leave untouched" branch. So a
    // link the registry FULLY RESOLVED is silently never rewritten.
    //
    // ✅ Fixed would be: the outer href `url` rewritten, the nesting preserved.
    expect(transform(IMAGE_IN_LINK)).toBe(IMAGE_IN_LINK);

    // A different wrong answer from the same input: no registry lookup here, so
    // the callback rewrites whatever the regex captured — the INNER image href.
    // The outer target is untouched by both.
    expect(rewriteBodyLinks(IMAGE_IN_LINK, (href) => `${PREFIX}${href}`)).toBe(
      '[![alt](REWRITTEN/img.png)](url)',
    );
  });
});
