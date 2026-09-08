/**
 * Characterization tests for the markdown link-rewriting divergence.
 *
 * ✅ **`transformContent`'s arm is now FIXED** — it no longer replays a regex and
 * correlates by href; it splices the parsed link's own `[startOffset, endOffset)`
 * span. The wrong-arm expectations this file used to pin were flipped when the fix
 * landed, and the tests below now assert correct behaviour for that rewriter.
 *
 * ⚠️ **`rewriteBodyLinks`'s arm is still wrong, deliberately.** It takes no parsed
 * links — only `(body, rewriteHref)` — so it cannot be span-driven without an API
 * change, and which grammar is correct there is a product call about what a link IS.
 * Its wrong answer stays pinned below so it cannot drift further unnoticed.
 *
 * This file exists because the divergence was found on 2026-09-04, recorded in prose
 * in both modules' docstrings, and then sat for two days with **both suites green** —
 * nothing mechanical read the prose. A defect that no test can see is free to get
 * worse, and a second grammar had already appeared without anyone noticing.
 *
 * Do NOT "fix" a failure here by editing an expectation: a change in these values
 * means a grammar moved, which is exactly the event this file exists to surface.
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
import type { ResourceLink } from '../src/schemas/resource-metadata.js';

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

  it('STILL DISAGREES on an image inside a link — but transformContent is now right', () => {
    // ✅ FIXED. `transformContent` splices the parsed link's own span, so it
    // rewrites the OUTER href and re-emits the nested image verbatim as the
    // link's raw text. Before the fix this returned the input unchanged: the
    // regex replay captured the INNER href `img.png`, missed the href→link map
    // (which holds only `url`), and took the "leave untouched" branch — so a
    // link the registry had FULLY RESOLVED was silently never rewritten.
    expect(transform(IMAGE_IN_LINK)).toBe('[![alt](img.png)](REWRITTEN/url)');

    // ❌ STILL WRONG, and deliberately pinned. `rewriteBodyLinks` has no parsed
    // links to splice from, so its regex still captures the INNER image href.
    // Fixing it requires an API change and a ruling on which grammar is correct.
    expect(rewriteBodyLinks(IMAGE_IN_LINK, (href) => `${PREFIX}${href}`)).toBe(
      '[![alt](REWRITTEN/img.png)](url)',
    );
  });

  it('rewrites link text containing balanced brackets, which the regex could not match', () => {
    // The regex excludes `[` from link text (deliberately — see MARKDOWN_LINK_REGEX)
    // so it never matched this construct and the link went unrewritten. mdast
    // reports it as one link with a full span, so the span-driven pass handles it.
    expect(transform('[a [b] c](x.md)')).toBe('[a [b] c](REWRITTEN/x.md)');
  });

  it('leaves a code-span EXAMPLE alone even when a real link shares its href', () => {
    // The regex replay saw both occurrences and was saved only by code masking.
    // mdast reports just the real link, so the example survives structurally.
    expect(transform('see `[x](dup.md)` and [x](dup.md)')).toBe(
      'see `[x](dup.md)` and [x](REWRITTEN/dup.md)',
    );
  });

  it('still rewrites a link the parser located only by LINE, via the regex fallback', () => {
    // `startOffset`/`endOffset` are OPTIONAL on ResourceLinkSchema, and the HTML
    // producer really does emit a link carrying a line and no offsets (a namespaced
    // `<a xlink:href>`, whose element has a location while a span lookup on the bare
    // local name misses). Such a link has no span to splice, so it must fall back to
    // the pre-span regex replay rather than being silently dropped — which is what a
    // naive span-only rewrite would do.
    const spanless: ResourceLink[] = [
      { text: 'ghost', href: 'ghost.md', type: 'local_file', line: 1, nodeType: 'link' },
    ];
    expect(transformContent('[ghost](ghost.md)', spanless, {
      linkRewriteRules: [],
      defaultTemplate: PASSTHROUGH_TEMPLATE,
      context: {},
    })).toBe('[ghost](REWRITTEN/ghost.md)');
  });

  it('does not let a spanless link reach INSIDE a spliced construct', () => {
    // The fallback replay runs only over the gaps between spliced spans. Were it run
    // over the whole document it would match the inner image href of the badge and
    // rewrite it too — reintroducing the exact defect the span pass removes.
    //
    // ⚠️ This asserts the SAME string as the image-in-link test above, which is what
    // an absence pin looks like and is also how a vacuous test looks. It is not
    // vacuous: REVERT-TESTED by making `rewriteInlineLinks` replay the fallback over
    // spliced spans as well as the gaps, which turns THIS test red
    // (`[![alt](REWRITTEN/img.png)](REWRITTEN/url)`) and leaves all eight others
    // green. Do not delete it as redundant with its neighbour — the neighbour passes
    // under that defect.
    const parsed = parseLinks(IMAGE_IN_LINK);
    const withGhost: ResourceLink[] = [
      ...parsed,
      { text: 'alt', href: 'img.png', type: 'local_file', line: 1, nodeType: 'link' },
    ];
    expect(transformContent(IMAGE_IN_LINK, withGhost, {
      linkRewriteRules: [],
      defaultTemplate: PASSTHROUGH_TEMPLATE,
      context: {},
    })).toBe('[![alt](img.png)](REWRITTEN/url)');
  });

  it('leaves a reference-style USE alone — rewriting it would change the link form', () => {
    // `[t][id]` has a span, but the span is not an inline `[...](...)` construct.
    // Splicing a template over it would silently convert a reference use into an
    // inline link, so the span pass declines it and behaviour is unchanged.
    expect(transform('[t][id]\n\n[id]: /u')).toContain('[t][id]');
  });
});
