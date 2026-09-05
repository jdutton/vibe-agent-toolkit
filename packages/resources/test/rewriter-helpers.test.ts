import { describe, expect, it } from 'vitest';

import { openFrontmatter } from '../src/frontmatter-editor.js';
import {
  rewriteBodyLinks,
  rewriteFrontmatterFieldsAtPaths,
  rewriteFrontmatterUriReferencesFromSchema,
} from '../src/rewriter-helpers.js';

const OLD_PREFIX = '/docs/old/';
const NEW_PREFIX = '/docs/new/';

function expectAdrsArrayRewritten(out: string): void {
  expect(out).toContain('/docs/new/0007.md');
  expect(out).toContain('/docs/new/0011.md');
  expect(out).toContain('# primary');
  expect(out).toContain('# secondary');
}

describe('rewriteFrontmatterFieldsAtPaths', () => {
  const REWRITE = (href: string): string => href.replace(OLD_PREFIX, NEW_PREFIX);

  it('rewrites a top-level scalar', () => {
    const input = `---
parent_spec: /docs/old/foo.md  # important
title: Example
---
# Body
`;
    const editor = openFrontmatter(input);
    rewriteFrontmatterFieldsAtPaths(editor, ['parent_spec'], REWRITE);
    const out = editor.toString();
    expect(out).toContain('/docs/new/foo.md');
    expect(out).toContain('# important'); // comment survives
  });

  it('rewrites every string in an array via [] suffix', () => {
    const input = `---
adrs-cited:
  - /docs/old/0007.md  # primary
  - /docs/old/0011.md  # secondary
---
# Body
`;
    const editor = openFrontmatter(input);
    rewriteFrontmatterFieldsAtPaths(editor, ['adrs-cited[]'], REWRITE);
    expectAdrsArrayRewritten(editor.toString());
  });

  it('rewrites nested dotted paths', () => {
    const input = `---
meta:
  parent: /docs/old/parent.md
  refs:
    - /docs/old/a.md
---
# Body
`;
    const editor = openFrontmatter(input);
    rewriteFrontmatterFieldsAtPaths(editor, ['meta.parent', 'meta.refs[]'], REWRITE);
    const out = editor.toString();
    expect(out).toContain('/docs/new/parent.md');
    expect(out).toContain('/docs/new/a.md');
  });

  it('no-ops on missing paths', () => {
    const input = `---
existing: /docs/old/foo.md
---
# Body
`;
    const editor = openFrontmatter(input);
    rewriteFrontmatterFieldsAtPaths(editor, ['nonexistent', 'also.missing[]'], REWRITE);
    const out = editor.toString();
    expect(out).toContain('/docs/old/foo.md'); // unchanged
  });

  it('skips non-string values', () => {
    const input = `---
title: A title
count: 5
flag: true
---
# Body
`;
    const editor = openFrontmatter(input);
    rewriteFrontmatterFieldsAtPaths(editor, ['count', 'flag'], (s) => s + '-rewritten');
    const out = editor.toString();
    expect(out).toContain('count: 5');
    expect(out).toContain('flag: true');
  });
});

describe('rewriteFrontmatterUriReferencesFromSchema', () => {
  const URI_REF_SCHEMA = {
    type: 'object',
    properties: {
      parent_spec: { type: 'string', format: 'uri-reference' },
      'adrs-cited': {
        type: 'array',
        items: { type: 'string', format: 'uri-reference' },
      },
      title: { type: 'string' }, // no format — should NOT be rewritten
    },
  };

  it('rewrites schema-annotated scalar URI-refs', () => {
    const input = `---
parent_spec: /docs/old/foo.md  # primary
title: /docs/old/should-not-rewrite.md
---
# Body
`;
    const editor = openFrontmatter(input);
    rewriteFrontmatterUriReferencesFromSchema(
      editor,
      URI_REF_SCHEMA,
      (href) => href.replace(OLD_PREFIX, NEW_PREFIX),
    );
    const out = editor.toString();
    expect(out).toContain('parent_spec: /docs/new/foo.md');
    expect(out).toContain('# primary');
    expect(out).toContain('title: /docs/old/should-not-rewrite.md'); // not URI-ref
  });

  it('rewrites schema-annotated array URI-refs per-item with comments preserved', () => {
    const input = `---
adrs-cited:
  - /docs/old/0007.md  # primary
  - /docs/old/0011.md  # secondary
---
# Body
`;
    const editor = openFrontmatter(input);
    rewriteFrontmatterUriReferencesFromSchema(
      editor,
      URI_REF_SCHEMA,
      (href) => href.replace(OLD_PREFIX, NEW_PREFIX),
    );
    expectAdrsArrayRewritten(editor.toString());
  });

  it('no-ops on schemas with no URI-ref fields', () => {
    const plainSchema = {
      type: 'object',
      properties: { title: { type: 'string' } },
    };
    const input = `---
title: hello
---
# Body
`;
    const editor = openFrontmatter(input);
    rewriteFrontmatterUriReferencesFromSchema(editor, plainSchema, () => 'CHANGED');
    expect(editor.toString()).toBe(input);
  });
});

describe('rewriteBodyLinks', () => {
  const REWRITE = (href: string): string => href.replace(OLD_PREFIX, NEW_PREFIX);

  it('rewrites inline link hrefs', () => {
    const input = 'See [foo](/docs/old/foo.md) and [bar](./other.md).\n';
    expect(rewriteBodyLinks(input, REWRITE)).toBe(
      'See [foo](/docs/new/foo.md) and [bar](./other.md).\n',
    );
  });

  it('rewrites reference-style definitions', () => {
    const input = `See [foo][1] for details.

[1]: /docs/old/foo.md
`;
    const out = rewriteBodyLinks(input, REWRITE);
    expect(out).toContain('[1]: /docs/new/foo.md');
  });

  it('leaves non-matching links untouched', () => {
    const input = 'External: [google](https://google.com)\n';
    expect(rewriteBodyLinks(input, REWRITE)).toBe(input);
  });

  it('handles fragments correctly (rewrite is applied to the full href)', () => {
    const input = '[link](/docs/old/foo.md#section)\n';
    expect(rewriteBodyLinks(input, REWRITE)).toBe('[link](/docs/new/foo.md#section)\n');
  });

  /**
   * The two patterns were rewritten to retire a ReDoS advisory, and a
   * performance edit is a BEHAVIOUR edit until something says otherwise. This
   * file had not changed since `f5535c80` (#106, v0.1.38), so nothing pinned
   * either property and one of them had already moved.
   *
   * 🪤 This repo's recorded trap is that the OBVIOUS ReDoS rewrite — an atomic
   * group, `(?=(X))\1` — satisfies the linter while staying quadratic. So the
   * timing case below is not ceremony: a green lint run is not evidence, and
   * the shape of the curve is what says "linear", not one absolute number on
   * one machine.
   */
  describe('the ReDoS-hardened patterns', () => {
    /** Rewrites anything at all, so a rewrite is observable wherever one happens. */
    const TO_X = (): string => 'X';

    it('is LINEAR on a long run of unclosed brackets, not quadratic', () => {
      // The adversarial input the advisory is about. Before `(?<!\[)`, every
      // `[` was a start position doing an O(n) scan: measured 9.4 / 35.1 /
      // 139.2 / 549.6 ms at n = 5k / 10k / 20k / 40k — x4 per doubling.
      //
      // 🪤 The assertion is a RATIO between two sizes, never a millisecond
      // floor. A wall-clock bound is a second requirement the machine decides,
      // and this repo has already shipped one test that reds under load for
      // that reason. Quadratic gives ~4x per doubling; linear gives ~1x. A
      // ceiling of 8x is far above the noise on a loaded machine and far below
      // what a quadratic regression at these sizes produces.
      const time = (n: number): number => {
        const input = '['.repeat(n);
        const started = performance.now();
        rewriteBodyLinks(input, TO_X);
        return performance.now() - started;
      };

      // Warm the JIT so the first measurement is not paying for compilation.
      time(2000);
      const small = Math.max(time(20_000), 1);
      const large = Math.max(time(40_000), 1);

      expect(large / small).toBeLessThan(8);
    });

    it('still finds a link nested inside a run of brackets', () => {
      // 🔑 What the `(?<!\[)` lookbehind must NOT cost. Skipping non-initial
      // brackets is only sound because a match starting at the second `[` of a
      // run is also matchable from the first — the negated class admits `[`.
      // These are the cases that would red if that argument were wrong.
      expect(rewriteBodyLinks('[[a](/docs/old/x.md)', REWRITE))
        .toBe('[[a](/docs/new/x.md)');
      expect(rewriteBodyLinks('z[[[a](/docs/old/x.md)', REWRITE))
        .toBe('z[[[a](/docs/new/x.md)');
      expect(rewriteBodyLinks('[[a](/docs/old/x.md)[b](/docs/old/y.md)', REWRITE))
        .toBe('[[a](/docs/new/x.md)[b](/docs/new/y.md)');
    });

    it('rewrites an image nested inside a link, using the INNER target', () => {
      // 📌 Pinned as OBSERVED behaviour, not endorsed. `[![alt](img)](url)`
      // resolves to the inner target here, and VAT's other markdown link
      // rewriter disagrees about this exact shape — an open, unresolved product
      // question. This test exists so the ReDoS rewrite cannot be blamed for
      // moving it: the answer is identical before and after.
      expect(rewriteBodyLinks('[![alt](/docs/old/i.png)](/docs/old/u.md)', REWRITE))
        .toBe('[![alt](/docs/new/i.png)](/docs/old/u.md)');
    });

    it('leaves a reference definition whose destination is only whitespace', () => {
      // 🚨 The behaviour that MOVED, pinned so it is a decision rather than a
      // side effect. `\s*(.+)$` let the whitespace run and the capture both
      // match a space, so `[a]:` followed by spaces captured a single space and
      // was rewritten. `\s*(\S[^\n]*)$` requires a real character, so the line
      // is left alone. A definition with no destination is malformed either
      // way; not rewriting it is the better answer, and it is now the pinned
      // one.
      expect(rewriteBodyLinks('[a]:   \n', TO_X)).toBe('[a]:   \n');
      expect(rewriteBodyLinks('[a]:\n', TO_X)).toBe('[a]:\n');
    });

    it('still rewrites a definition with a real destination, spaces and all', () => {
      // The control for the case above: the guard must refuse an EMPTY
      // destination without refusing a PADDED one, or the fix has quietly
      // stopped rewriting real definitions.
      //
      // 📌 Note the padding COLLAPSES to one space. That is the replacement
      // template (`[${ref}]: ${next}`), not the regex, and it is pre-existing —
      // pinned here because this is the first test to look at a padded
      // definition at all, and a reader comparing input to output would
      // otherwise read the collapse as part of the ReDoS change. It happens
      // only when the href actually changes; an unchanged one returns the
      // original text untouched.
      expect(rewriteBodyLinks('[a]:    /docs/old/x.md\n', REWRITE))
        .toBe('[a]: /docs/new/x.md\n');
      expect(rewriteBodyLinks('[a]: /docs/old/x.md "title"\n', REWRITE))
        .toBe('[a]: /docs/new/x.md "title"\n');
      // Unchanged href => the line survives byte for byte, padding included.
      expect(rewriteBodyLinks('[a]:    /elsewhere/x.md\n', REWRITE))
        .toBe('[a]:    /elsewhere/x.md\n');
    });
  });
});
