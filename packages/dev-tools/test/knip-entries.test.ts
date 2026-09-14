/**
 * The knip entries derived from `package.json` `exports` are the whole reason
 * a subpath module's re-exports stop flapping by platform (traps.md, "A
 * subpath module's re-exports flap by platform under knip"). The derivation
 * must read every condition shape this monorepo publishes — `{import, types}`
 * (utils, agent-runtime) AND `{default, types}` (resources, resource-compiler,
 * vat-example-cat-agents) — or a workspace silently gets no entries and the
 * flap stays open there. `bun run unused-exports` over the real manifests is the gate.
 */

import { describe, expect, it } from 'vitest';

import { sourceEntriesOf } from '../knip.config.js';

describe('sourceEntriesOf', () => {
  it('maps a bare string target under dist/ to its source', () => {
    expect(sourceEntriesOf({ '.': './dist/index.js' })).toEqual(['src/index.ts']);
  });

  it('reads the import condition', () => {
    expect(sourceEntriesOf({ './fs': { types: './dist/fs.d.ts', import: './dist/fs.js' } })).toEqual(['src/fs.ts']);
  });

  it('reads the default condition when there is no import condition', () => {
    expect(sourceEntriesOf({ './remark-parser': { types: './dist/remark-parser.d.ts', default: './dist/remark-parser.js' } })).toEqual([
      'src/remark-parser.ts',
    ]);
  });

  it('prefers import over default when both are present', () => {
    expect(sourceEntriesOf({ '.': { import: './dist/esm.js', default: './dist/other.js' } })).toEqual(['src/esm.ts']);
  });

  it('keeps a dist/ pattern as a source glob', () => {
    expect(sourceEntriesOf({ './lanes/*': './dist/lanes/*.js' })).toEqual(['src/lanes/*.ts']);
  });

  it.each([
    ['a schemas tree outside dist/', { './schemas/*': './schemas/*' }],
    ['a .cjs target', { './eslint': './eslint/index.cjs' }],
    ['a types-only condition map', { '.': { types: './dist/index.d.ts' } }],
    ['no exports field', undefined],
    ['a non-object exports field', './dist/index.js'],
  ])('yields no entry for %s', (_label, exports) => {
    expect(sourceEntriesOf(exports)).toEqual([]);
  });
});
