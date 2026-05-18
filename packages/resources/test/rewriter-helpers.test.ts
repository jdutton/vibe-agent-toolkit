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
});
