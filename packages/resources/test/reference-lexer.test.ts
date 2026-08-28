import { describe, expect, it } from 'vitest';

import { blobReferencesFor } from '../src/projection/blob-references.js';
import {
  codeContextRangesFrom,
  detectVariableExpansion,
  findLexicalReferences,
} from '../src/reference-lexer.js';
import { openRemarkSession } from '../src/remark-parser.js';

/** Hoisted because `sonarjs/no-duplicate-string` fires at three uses. */
const AT_README = '@README.md';
/** Hoisted for the same reason — asserted in three of the bare-token tests. */
const BARE_TOKEN = 'bare-token';

/**
 * Ranges through the real seam — the shipped `spans-and-kinds` capability, then
 * the partition — rather than through a locally composed processor. A local
 * processor is a second definition of which plugins VAT parses with, and a
 * lexer test that disagrees with the shipped chain tests a parser nobody runs.
 */
function rangesOf(source: string) {
  return codeContextRangesFrom(openRemarkSession(source).spansAndKinds().spans);
}

function lex(source: string) {
  return findLexicalReferences(source, rangesOf(source));
}

describe('codeContextRangesFrom', () => {
  it('separates fenced blocks from inline code spans', () => {
    const ranges = rangesOf('Text with `a span` here.\n\n```\nfenced\n```\n');
    expect(ranges.codeSpans).toHaveLength(1);
    expect(ranges.fences).toHaveLength(1);
  });

  it('treats an indented code block as a fence', () => {
    const ranges = rangesOf('Text.\n\n    indented\n');
    expect(ranges.fences).toHaveLength(1);
    expect(ranges.codeSpans).toHaveLength(0);
  });

  it('excludes markdown link, definition, frontmatter and raw-HTML spans', () => {
    const ranges = rangesOf('---\nid: x\n---\n\n[a](./b.md)\n\n[ref]: ./c.md\n\n<!-- @d.md -->\n');
    expect(ranges.excluded.length).toBeGreaterThanOrEqual(4);
  });
});

describe('detectVariableExpansion', () => {
  it('detects each syntax', () => {
    expect(detectVariableExpansion('${CLAUDE_PLUGIN_ROOT}/x.js')).toBe('brace');
    expect(detectVariableExpansion('$HOME/x.js')).toBe('bare');
    expect(detectVariableExpansion('%USERPROFILE%/x.js')).toBe('percent');
    expect(detectVariableExpansion('$env:APPDATA/x.js')).toBe('powershell');
  });

  it('prefers brace over bare when both could match', () => {
    expect(detectVariableExpansion('${A}/$B')).toBe('brace');
  });

  it('returns null for a plain path', () => {
    expect(detectVariableExpansion('docs/guide.md')).toBeNull();
  });

  it('does not read a lone dollar or percent as an expansion', () => {
    expect(detectVariableExpansion('costs $5')).toBeNull();
    expect(detectVariableExpansion('100%')).toBeNull();
  });
});

describe('findLexicalReferences — @-prefixed tokens', () => {
  it('finds an @ import at the start of a line', () => {
    const refs = lex(`${AT_README}\n`);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      raw: AT_README,
      line: 1,
      column: 1,
      syntacticForm: 'at-prefixed',
      leadingAt: true,
      hasExtension: true,
      slashCount: 0,
      inCodeSpan: false,
      inFence: false,
    });
  });

  it('records column as 1-based', () => {
    const refs = lex('See @docs/x.md now\n');
    expect(refs[0]?.column).toBe(5);
    expect(refs[0]?.slashCount).toBe(1);
  });

  it('records an @ token inside a fence WITH inFence set, rather than dropping it', () => {
    const refs = lex('```\n@docs/x.md\n```\n');
    expect(refs).toHaveLength(1);
    expect(refs[0]?.inFence).toBe(true);
    expect(refs[0]?.inCodeSpan).toBe(false);
  });

  it('records an @ token inside a code span WITH inCodeSpan set', () => {
    const refs = lex('Use `@docs/x.md` here.\n');
    expect(refs).toHaveLength(1);
    expect(refs[0]?.inCodeSpan).toBe(true);
    expect(refs[0]?.inFence).toBe(false);
  });

  it('classifies a variable-bearing @ token as env-anchored, not at-prefixed', () => {
    const refs = lex('@${CLAUDE_PLUGIN_ROOT}/scripts/x.js\n');
    expect(refs[0]?.syntacticForm).toBe('env-anchored');
    expect(refs[0]?.leadingAt).toBe(true);
    expect(refs[0]?.variableExpansion).toBe('brace');
  });

  it('finds a package-shaped @ token — the collision the blob layer must NOT resolve', () => {
    const refs = lex('@vibe-agent-toolkit/utils\n');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ syntacticForm: 'at-prefixed', hasExtension: false, slashCount: 1 });
  });

  it('ignores an @ inside a markdown link destination — already a markdown-form reference', () => {
    expect(lex('[a](@docs/x.md)\n')).toHaveLength(0);
  });

  it('ignores an @ inside frontmatter', () => {
    expect(lex('---\nsource: "@docs/x.md"\n---\n\nBody.\n')).toHaveLength(0);
  });

  it('ignores an @ inside a block HTML comment — stripped before injection', () => {
    expect(lex('<!-- @docs/x.md -->\n')).toHaveLength(0);
  });

  it('ignores an email-shaped @ that is not token-initial', () => {
    expect(lex('Mail me at jeff@example.com now.\n')).toHaveLength(0);
  });

  it('strips trailing sentence punctuation from the token', () => {
    const refs = lex(`Read ${AT_README}.\n`);
    expect(refs[0]?.raw).toBe(AT_README);
  });

  it('returns references in document order', () => {
    const refs = lex('@a.md\n\n@b.md\n');
    expect(refs.map((r) => r.raw)).toEqual(['@a.md', '@b.md']);
  });
});

describe('findLexicalReferences — bare tokens', () => {
  it('finds a slashed token with a file extension', () => {
    const refs = lex('See packages/utils/src/index.ts for details.\n');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      raw: 'packages/utils/src/index.ts',
      syntacticForm: BARE_TOKEN,
      hasExtension: true,
      leadingAt: false,
      slashCount: 3,
    });
  });

  it('finds an explicitly relative token even with no extension', () => {
    const refs = lex('Look in ./scripts for the runner.\n');
    expect(refs[0]).toMatchObject({ raw: './scripts', syntacticForm: BARE_TOKEN, hasExtension: false });
  });

  it('finds a parent-relative token', () => {
    expect(lex('From ../shared/config.yaml here.\n')[0]?.raw).toBe('../shared/config.yaml');
  });

  it('records a bare token inside a code span with inCodeSpan set — the deferred inference class', () => {
    const refs = lex('Run `packages/cli/src/index.ts` now.\n');
    expect(refs).toHaveLength(1);
    expect(refs[0]?.inCodeSpan).toBe(true);
    expect(refs[0]?.syntacticForm).toBe(BARE_TOKEN);
  });

  it('ignores a slashed token with no extension — "and/or", "read/write"', () => {
    expect(lex('The read/write and/or flag.\n')).toHaveLength(0);
  });

  it('ignores a bare word with an extension but no slash — "e.g", "i.e", "v1.2"', () => {
    expect(lex('For example, e.g. v1.2 works.\n')).toHaveLength(0);
  });

  it('ignores a URL — external references are a markdown/lens concern, not a path candidate', () => {
    expect(lex('See https://example.com/docs/x.md for more.\n')).toHaveLength(0);
  });

  it('ignores a date and a fraction', () => {
    expect(lex('On 2026/08/12 about 1/2 of it.\n')).toHaveLength(0);
  });

  it('still ignores anything inside a markdown link destination', () => {
    expect(lex('[a](packages/utils/src/index.ts)\n')).toHaveLength(0);
  });
});

describe('findLexicalReferences — hasExtension across a query string or fragment', () => {
  // Task B/B3 fixed `lexicalFeatures()` in `projection/blob-references.ts` to strip a
  // trailing `?query` or `#fragment` before testing `EXTENSION_SUFFIX`, because the raw
  // regex tested against the WHOLE href and a suffix pushed the extension off the string's
  // own end. `reference-lexer.ts:345` runs the identical `EXTENSION_SUFFIX` test but was not
  // touched by that fix. These three cases are the reachable proof: none of them route
  // through the bare-token `isCandidate` gate at line 394 (which requires the token's own end
  // to already match `EXTENSION_SUFFIX`, so a bare token with a trailing query never becomes a
  // candidate at all) — they are admitted UNCONDITIONALLY via `@`-prefix, `./` explicit-relative,
  // or a variable expansion, so a query/fragment tail reaches `toLexicalReference` untouched.
  it('an @-prefixed token with a trailing query string', () => {
    const refs = lex('See @docs/guide.md?v=2 for details.\n');
    expect(refs).toHaveLength(1);
    expect(refs[0]?.raw).toBe('@docs/guide.md?v=2');
    expect(refs[0]?.hasExtension).toBe(true);
  });

  it('an explicitly relative token with a trailing fragment', () => {
    const refs = lex('Look in ./guide.md#section now.\n');
    expect(refs).toHaveLength(1);
    expect(refs[0]?.raw).toBe('./guide.md#section');
    expect(refs[0]?.hasExtension).toBe(true);
  });

  it('a variable-expansion token with a trailing query string', () => {
    const refs = lex('Open ${CLAUDE_PLUGIN_ROOT}/guide.md?v=2 now.\n');
    expect(refs).toHaveLength(1);
    expect(refs[0]?.raw).toBe('${CLAUDE_PLUGIN_ROOT}/guide.md?v=2');
    expect(refs[0]?.hasExtension).toBe(true);
  });

  it('negative control: still reports false when the part BEFORE the query has no extension', () => {
    const refs = lex('See @docs/README?v=2 for details.\n');
    // A token whose path half has no extension at all — stripping the query must not make
    // this read `true`. Guards against a fix that always returns `true` for anything
    // carrying a `?` or `#`, rather than actually re-testing the stripped prefix.
    expect(refs[0]?.raw).toBe('@docs/README?v=2');
    expect(refs[0]?.hasExtension).toBe(false);
  });
});

describe('hasExtension parity across producers', () => {
  it('the lexer and the AST-derived row report the SAME hasExtension for an identical query-bearing reference', () => {
    // `EXTENSION_SUFFIX` and `stripQueryOrFragment` used to be two independent copies — one
    // here, one in `projection/blob-references.ts` — each carrying a docstring asserting the
    // other agreed with it. That assertion went false without either file changing its own
    // behaviour (B3 fixed one copy; Task C found the other had silently drifted). Both producers
    // now import the SAME two symbols from this module, so the invariant is enforced by the
    // module system rather than by a comment. This test drives BOTH real computation paths —
    // `findLexicalReferences` for the lexer, `blobReferencesFor` for the AST — on the identical
    // reference string, so it goes red the moment anyone reintroduces a second copy that drifts,
    // not merely when a query string is mishandled by one side alone.
    const rawRef = '@docs/guide.md?v=2';

    const lexed = lex(`See ${rawRef} for details.\n`);
    expect(lexed[0]?.hasExtension).toBe(true);

    const astRows = blobReferencesFor(`markdown.${'c'.repeat(64)}`, {
      content: '',
      sizeBytes: 0,
      headings: [],
      estimatedTokenCount: 0,
      links: [{
        text: 'q',
        href: rawRef,
        type: 'local_file',
        line: 1,
        nodeType: 'link',
        startOffset: 0,
        endOffset: rawRef.length,
      }],
    });
    expect(astRows[0]?.hasExtension).toBe(true);

    expect(astRows[0]?.hasExtension).toBe(lexed[0]?.hasExtension);
  });
});

describe('a code span followed by prose', () => {
  // ⛔ These assert `inCodeSpan`, NOT just a tidy `raw`. `raw` is the visible
  // symptom; the DEFECT is that `end` is derived from `raw.length`, so a token
  // running past its closing backtick escapes the code-span range and records
  // `inCodeSpan: false`. The closure's guard reads that column and therefore
  // never fires. Asserting only `raw` would keep passing if the offsets were
  // reintroduced, which is the failure this suite exists to prevent.
  // Scope names are SYNTHETIC. The shapes are taken from a real adopter's prose,
  // but this repository is public and a proprietary name cannot be retracted from
  // git history once pushed — the structural gate enforces this, and it caught
  // the first draft of these very cases.
  it.each([
    ['a possessive', 'a re-export of `@scope/pkg`\'s helper\n', '@scope/pkg'],
    // 🪤 NO space before the `**`. With one, the closing backtick is the token's
    // last character and `stripTrailingPunctuation` already removed it — that
    // spelling passes with or without the fix, and a RED run proved it vacuous.
    ['closing emphasis', '**never author new `@scope`**\n', '@scope'],
    ['a full stop and emphasis', '**TypeScript, `@other-scope`.**\n', '@other-scope'],
  ])('marks a scope named inside a span as in-code-span, despite %s', (_case, source, expected) => {
    const [reference, ...rest] = lex(source);

    expect(rest).toHaveLength(0);
    expect(reference?.raw).toBe(expected);
    expect(reference?.inCodeSpan).toBe(true);
  });

  it('leaves a reference OUTSIDE any span reachable', () => {
    // The negative control. Truncating at a backtick must not make ordinary
    // references vanish — a fix that silenced the false positives by dropping
    // every candidate would pass the three cases above and break the feature.
    const [reference, ...rest] = lex('See @docs/real-import.md for the rule.\n');

    expect(rest).toHaveLength(0);
    expect(reference?.raw).toBe('@docs/real-import.md');
    expect(reference?.inCodeSpan).toBe(false);
  });
});

describe('the cut is at the FIRST backtick, not the last', () => {
  // ⛔ `truncateAtBacktick` uses `indexOf`, and every case above is blind to
  // whether it does: none of their tokens carries a SECOND backtick with
  // non-backtick content after it, so `indexOf` and `lastIndexOf` return the
  // same index and the two spellings are indistinguishable. A mutation sweep
  // caught that — `indexOf` → `lastIndexOf` survived the whole suite.
  //
  // `indexOf` is the correct rule: a code span closes at its FIRST backtick, so
  // everything past that backtick belongs to the prose around the span and must
  // not be swallowed into the reference. These two fixtures put a code span
  // immediately against more backticked text with NO whitespace between them —
  // one whitespace-delimited token holding three backticks — which is the only
  // shape where the two spellings diverge.
  //
  // 🪤 The divergence must survive `stripTrailingPunctuation`, which runs after
  // the truncation. `token.slice(0, close)` vs `slice(0, close + 1)` does NOT
  // survive it (the backtick is in TRAILING_PUNCTUATION, so it is stripped
  // either way) — hence both fixtures end their swallowed tail in a LETTER, so
  // the stripper has nothing to remove and the two branches keep genuinely
  // different `raw` values.
  it('does not swallow the prose after a span into an @-prefixed reference', () => {
    // Under `lastIndexOf`: raw becomes '@scope/one`@scope/two', whose `end` is
    // derived from `raw.length` and therefore runs past the code span — so
    // `inCodeSpan` flips to false as well, re-opening exactly the closure-guard
    // defect the describe above exists to prevent.
    const [reference, ...rest] = lex('Prefer `@scope/one`@scope/two` over both.\n');

    expect(rest).toHaveLength(0);
    expect(reference?.raw).toBe('@scope/one');
    expect(reference?.inCodeSpan).toBe(true);
  });

  it('still admits a bare token whose swallowed tail would push its extension off the end', () => {
    // The cardinality half of the kill. `isCandidate` admits a bare token only
    // when `EXTENSION_SUFFIX` matches its own end, so under `lastIndexOf` the
    // raw is 'docs/one.md`and-more' — the extension is no longer terminal, the
    // token is rejected, and the reference DISAPPEARS from `blob_references`
    // entirely rather than merely being reported with a scruffy `raw`.
    const [reference, ...rest] = lex('Run `docs/one.md`and-more` now.\n');

    expect(rest).toHaveLength(0);
    expect(reference?.raw).toBe('docs/one.md');
    expect(reference?.syntacticForm).toBe(BARE_TOKEN);
    expect(reference?.inCodeSpan).toBe(true);
  });
});
