/**
 * The projection router: the one module that composes "path -> mime -> parser kind".
 *
 * Each function is pinned against the composition the sites spelled before the
 * router existed, so moving a site onto it cannot change an answer.
 */

import { describe, expect, it } from 'vitest';

import { NO_PARSER_KIND } from '../src/content-key.js';
import { mimeTypeForPath, parserKindForMimeType } from '../src/mime-type.js';
import {
  createCollectionMimeResolver,
  mimeFor,
  parserKindForMime,
  parserKindForPath,
} from '../src/projection/router.js';

describe('parserKindForMime', () => {
  it.each([
    ['text/markdown', 'markdown'],
    ['text/html', 'html'],
    ['application/json', NO_PARSER_KIND],
    ['application/x-unknown-to-vat', NO_PARSER_KIND],
    [null, NO_PARSER_KIND],
  ] as const)('%s -> %s', (mime, expected) => {
    expect(parserKindForMime(mime)).toBe(expected);
  });
});

describe('parserKindForPath', () => {
  it.each(['/a/doc.md', '/a/page.html', '/a/module.ts', '/a/NOTES', '/a/README'])(
    '%s answers what the inline composition answered',
    (path) => {
      expect(parserKindForPath(path)).toBe(parserKindForMimeType(mimeTypeForPath(path)) ?? NO_PARSER_KIND);
    },
  );
});

describe('mimeFor', () => {
  const abs = '/repo/src/module.ts';
  const rel = 'src/module.ts';

  it('without a resolver is the built-in table', () => {
    expect(mimeFor(undefined, abs, rel)).toBe(mimeTypeForPath(abs));
  });

  it('with a resolver is the resolver', () => {
    const resolver = createCollectionMimeResolver({
      code: { include: ['**/*.ts'], mimeType: 'text/markdown' },
    });
    expect(mimeFor(resolver, abs, rel)).toBe('text/markdown');
    expect(mimeFor(resolver, abs, rel)).toBe(resolver.mimeFor(abs, rel));
  });

  it('with a resolver that declares nothing falls back to the built-in table', () => {
    const resolver = createCollectionMimeResolver(undefined);
    expect(mimeFor(resolver, abs, rel)).toBe(mimeTypeForPath(abs));
  });
});
