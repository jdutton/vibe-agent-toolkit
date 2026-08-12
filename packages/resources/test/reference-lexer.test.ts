import type { Root } from 'mdast';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { describe, expect, it } from 'vitest';

import {
  collectCodeContextRanges,
  detectVariableExpansion,
  findLexicalReferences,
} from '../src/reference-lexer.js';

/** Hoisted because `sonarjs/no-duplicate-string` fires at three uses. */
const AT_README = '@README.md';
/** Hoisted for the same reason — asserted in three of the bare-token tests. */
const BARE_TOKEN = 'bare-token';

function parse(source: string): Root {
  return unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter).parse(source) as Root;
}

function lex(source: string) {
  return findLexicalReferences(source, parse(source));
}

describe('collectCodeContextRanges', () => {
  it('separates fenced blocks from inline code spans', () => {
    const source = 'Text with `a span` here.\n\n```\nfenced\n```\n';
    const ranges = collectCodeContextRanges(parse(source));
    expect(ranges.codeSpans).toHaveLength(1);
    expect(ranges.fences).toHaveLength(1);
  });

  it('treats an indented code block as a fence', () => {
    const ranges = collectCodeContextRanges(parse('Text.\n\n    indented\n'));
    expect(ranges.fences).toHaveLength(1);
    expect(ranges.codeSpans).toHaveLength(0);
  });

  it('excludes markdown link, definition, frontmatter and raw-HTML spans', () => {
    const source = '---\nid: x\n---\n\n[a](./b.md)\n\n[ref]: ./c.md\n\n<!-- @d.md -->\n';
    const ranges = collectCodeContextRanges(parse(source));
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
