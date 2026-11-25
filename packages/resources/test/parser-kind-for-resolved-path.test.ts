import { describe, expect, it } from 'vitest';

import { createCollectionMimeResolver, parserKindForResolvedPath } from '../src/projection/router.js';

const BASE = '/repo';

describe('parserKindForResolvedPath', () => {
  const builtIn = createCollectionMimeResolver(undefined);

  it.each([
    { path: '/repo/docs/a.md', kind: 'markdown' },
    { path: '/repo/docs/a.html', kind: 'html' },
    { path: '/repo/data/a.json', kind: 'none' },
    { path: '/repo/data/a.yaml', kind: 'none' },
  ])('routes $path to $kind with no declarations', ({ path, kind }) => {
    expect(parserKindForResolvedPath(path, builtIn, BASE)).toBe(kind);
  });

  it('routes a path outside the base directory by its absolute path', () => {
    expect(parserKindForResolvedPath('/elsewhere/a.md', builtIn, BASE)).toBe('markdown');
  });

  it('routes with no base directory by the absolute path', () => {
    expect(parserKindForResolvedPath('/repo/a.md', builtIn, undefined)).toBe('markdown');
  });
});
