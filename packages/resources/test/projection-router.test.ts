/**
 * The projection router: the one module that composes "path -> mime -> parser kind".
 *
 * Each function is pinned to concrete answers, never to the composition it
 * performs, so a change to the routing tables shows here as a changed answer.
 */

import { describe, expect, it } from 'vitest';

import { NO_PARSER_KIND } from '../src/content-key.js';
import { mimeTypeForPath } from '../src/mime-type.js';
import {
  createCollectionMimeResolver,
  MARKDOWN_BY_CONTRACT,
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
  it.each([
    ['/a/doc.md', 'markdown'],
    ['/a/guide.markdown', 'markdown'],
    ['/a/notes.txt', 'markdown'],
    ['/a/README', 'markdown'],
    ['/a/page.html', 'html'],
    ['/a/page.htm', 'html'],
    ['/a/PAGE.HTML', 'html'],
    ['/a/module.ts', NO_PARSER_KIND],
    ['/a/NOTES', NO_PARSER_KIND],
    ['/a/blob.unknown-to-vat', NO_PARSER_KIND],
  ] as const)('%s -> %s', (path, expected) => {
    expect(parserKindForPath(path)).toBe(expected);
  });
});

describe('MARKDOWN_BY_CONTRACT', () => {
  it('is the kind the router hands a .md file', () => {
    expect(MARKDOWN_BY_CONTRACT).toBe(parserKindForPath('SKILL.md'));
  });
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
