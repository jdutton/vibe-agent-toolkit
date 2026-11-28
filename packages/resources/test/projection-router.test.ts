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
  isDeclarationName,
  parserKindForMime,
  parserKindForPath,
  routingEmptiness,
  tsRouteDecision,
  tsRoutingFor,
  tsVariantOf,
  type TsRouting,
} from '../src/projection/router.js';
import { ProjectConfigSchema } from '../src/schemas/project-config.js';
import { TS_INSTANCE } from '../src/schemas/projection-ts.js';

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

/** A ts routing built from a parsed `resources.extractors.ts` block, or from no config at all. */
function tsRoutingOf(block?: Record<string, unknown>): TsRouting {
  return tsRoutingFor(block === undefined ? undefined : ProjectConfigSchema.parse({ resources: { extractors: { ts: block } } }));
}

/** The red seed that tests only the three standard declaration suffixes. */
const suffixOnlyRule = (path: string): boolean => ['.d.ts', '.d.mts', '.d.cts'].some((suffix) => path.endsWith(suffix));

/** The red seed that searches the whole path, directories included, for `.d.`. */
const wholePathRule = (path: string): boolean =>
  ['.d.ts', '.d.mts', '.d.cts'].some((suffix) => path.endsWith(suffix)) || (path.endsWith('.ts') && path.includes('.d.'));

describe('isDeclarationName: the dts rule (case-sensitive)', () => {
  it.each([
    'a.d.ts', 'a.d.mts', 'a.d.cts', 'src/lib/a.d.ts', 'a.d.json.ts', 'a.d.css.ts', 'foo.d.helper.ts', 'x.d.dir/a.d.ts', '.d.ts',
  ])('%s is a declaration name', (path) => {
    expect(isDeclarationName(path)).toBe(true);
  });

  it.each([
    'd.ts', 'a.D.ts', 'a.d.TS', 'a.d.tsx', 'a.d.ts.map', 'x.d.dir/y.ts', 'a.ts', 'a.d.json', 'a.d.js', 'ad.ts', 'a.d.json.mts',
  ])('%s is not a declaration name', (path) => {
    expect(isDeclarationName(path)).toBe(false);
  });

  it('red seed: a rule testing only the three standard suffixes misses a.d.json.ts', () => {
    expect(suffixOnlyRule('a.d.json.ts')).not.toBe(isDeclarationName('a.d.json.ts'));
  });

  it('red seed: a rule searching the whole path for .d. misreads x.d.dir/y.ts', () => {
    expect(wholePathRule('x.d.dir/y.ts')).not.toBe(isDeclarationName('x.d.dir/y.ts'));
  });
});

describe('tsVariantOf: the variant each extension names (case-sensitive)', () => {
  it.each([
    ['a.ts', 'ts'], ['a.mts', 'ts'], ['a.cts', 'ts'], ['src/x.d.dir/y.ts', 'ts'],
    ['a.d.ts', 'dts'], ['a.d.mts', 'dts'], ['a.d.cts', 'dts'], ['a.d.json.ts', 'dts'], ['foo.d.helper.ts', 'dts'],
    ['a.tsx', 'tsx'], ['a.d.tsx', 'tsx'],
    ['a.js', 'js'], ['a.jsx', 'js'], ['a.mjs', 'js'], ['a.cjs', 'js'],
  ] as const)('%s -> %s', (path, variant) => {
    expect(tsVariantOf(path)).toBe(variant);
  });

  it.each(['a.TS', 'a.Tsx', 'a.JS', 'a.d.ts.map', 'a.json', 'a.d.json', 'README.md', 'ts', 'a.mtsx', 'a.cjsx'])('%s is no variant', (path) => {
    expect(tsVariantOf(path)).toBeUndefined();
  });
});

describe('tsRouteDecision: static routes, exclude, node_modules', () => {
  it('routes every member with a routed extension by default', () => {
    const routing = tsRoutingOf();
    expect(tsRouteDecision('src/a.ts', routing)).toEqual({ variant: 'ts' });
    expect(tsRouteDecision('types/a.d.ts', routing)).toEqual({ variant: 'dts' });
    expect(tsRouteDecision('src/a.md', routing)).toEqual({ unrouted: 'extension' });
  });

  it('never routes a path under node_modules, at any depth', () => {
    const routing = tsRoutingOf({ exclude: [] });
    expect(tsRouteDecision('node_modules/@acme/x/index.d.ts', routing)).toEqual({ unrouted: 'node-modules' });
    expect(tsRouteDecision('packages/a/node_modules/x/a.js', routing)).toEqual({ unrouted: 'node-modules' });
  });

  it('lets exclude beat every routed extension and variant', () => {
    const routing = tsRoutingOf({ exclude: ['**/test/fixtures/invalid/**', 'gen/*.d.ts'] });
    expect(tsRouteDecision('packages/a/test/fixtures/invalid/bad.ts', routing)).toEqual({ unrouted: 'excluded' });
    expect(tsRouteDecision('gen/api.d.ts', routing)).toEqual({ unrouted: 'excluded' });
    expect(tsRouteDecision('gen/api.ts', routing)).toEqual({ variant: 'ts' });
  });

  it('matches exclude globs anchored at the root, dot segments included', () => {
    const routing = tsRoutingOf({ exclude: ['.config/**'] });
    expect(tsRouteDecision('.config/a.ts', routing)).toEqual({ unrouted: 'excluded' });
    expect(tsRouteDecision('pkg/.config/a.ts', routing)).toEqual({ variant: 'ts' });
  });

  it('is declared by a present block, even empty, and carries allowEmpty', () => {
    expect(tsRoutingOf()).toMatchObject({ declared: false, allowEmpty: false });
    expect(tsRoutingOf({})).toMatchObject({ declared: true, allowEmpty: false });
    expect(tsRoutingOf({ allowEmpty: true })).toMatchObject({ declared: true, allowEmpty: true });
  });
});

describe('the ts config block', () => {
  const parse = (ts: unknown): unknown => ProjectConfigSchema.safeParse({ resources: { extractors: { ts } } }).success;

  it('accepts exclude and allowEmpty: true', () => {
    expect(parse({ exclude: ['**/test/fixtures/invalid/**'], allowEmpty: true })).toBe(true);
  });

  it.each([
    ['include', { include: ['**/*.ts'] }],
    ['a variant override', { variants: { 'src/**': 'tsx' } }],
    ['allowEmpty: false', { allowEmpty: false }],
  ])('refuses %s', (_label, block) => {
    expect(parse(block)).toBe(false);
  });
});

describe('routingEmptiness: a declared instance that routes nothing refuses, by instance', () => {
  it('names the ts instance when a declared ts block routed nothing', () => {
    expect(routingEmptiness(TS_INSTANCE, 0, tsRoutingOf({}))).toMatch(/^resources\.extractors\.ts is declared, but it routed no file/);
  });

  it('is undefined undeclared, when routed, or under allowEmpty', () => {
    expect(routingEmptiness(TS_INSTANCE, 0, tsRoutingOf())).toBeUndefined();
    expect(routingEmptiness(TS_INSTANCE, 3, tsRoutingOf({}))).toBeUndefined();
    expect(routingEmptiness(TS_INSTANCE, 0, tsRoutingOf({ allowEmpty: true }))).toBeUndefined();
  });
});
