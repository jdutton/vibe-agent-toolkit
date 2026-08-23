import { describe, expect, it } from 'vitest';

import { claudeImportExtentDeclaration } from '../src/projection/contributors/claude-import-extent.js';
import {
  closureProvenance,
  type ClosureProvenanceInput,
} from '../src/projection/contributors/closure-extent.js';

import { closureFixtureFrom } from './helpers/claude-context-fixture.js';

// 🪤 The root is a path that does NOT exist on disk. This is the assertion that
// pins §6's "a pure function of the projection": if `resolveLocalHref`'s
// root-absolute branch ever starts stat-ing on the relative path, this suite
// fails rather than the claim quietly becoming false.
const ABSENT_ROOT = '/nonexistent-root-for-purity-assertion';

/** One `ClosureProvenanceInput`, built from real-lexer fixture files under {@link ABSENT_ROOT}. */
function inputFor(files: Record<string, string>, rootFile: string): ClosureProvenanceInput {
  const fixture = closureFixtureFrom(ABSENT_ROOT, files);
  return {
    root: ABSENT_ROOT,
    resourceRealizations: fixture.resourceRealizations,
    blobReferences: fixture.blobReferences,
    declaration: claudeImportExtentDeclaration(rootFile),
  };
}

describe('closureProvenance', () => {
  it('gives the root depth 0 and no importer', () => {
    const map = closureProvenance(inputFor({ 'CLAUDE.md': '@a.md\n', 'a.md': 'x\n' }, 'CLAUDE.md'));

    expect(map.get('CLAUDE.md')).toEqual({ depth: 0, viaPath: null });
  });

  it('attributes a one-hop import to the file that authored the token', () => {
    const map = closureProvenance(inputFor({ 'CLAUDE.md': '@a.md\n', 'a.md': 'x\n' }, 'CLAUDE.md'));

    expect(map.get('a.md')).toEqual({ depth: 1, viaPath: 'CLAUDE.md' });
  });

  it('carries depth through four hops and stops before the fifth', () => {
    const map = closureProvenance(inputFor({
      'CLAUDE.md': '@a.md\n',
      'a.md': '@b.md\n',
      'b.md': '@c.md\n',
      'c.md': '@d.md\n',
      'd.md': '@e.md\n',
      'e.md': 'too far\n',
    }, 'CLAUDE.md'));

    expect(map.get('d.md')).toEqual({ depth: 4, viaPath: 'c.md' });
    // The bound pinned from the OTHER side too: a one-sided assertion cannot tell
    // an off-by-one from a correct bound.
    expect(map.has('e.md')).toBe(false);
  });

  it('gives a diamond target the FIRST importer breadth-first reaches, once', () => {
    const map = closureProvenance(inputFor({
      'CLAUDE.md': '@a.md\n@b.md\n',
      'a.md': '@shared.md\n',
      'b.md': '@shared.md\n',
      'shared.md': 'x\n',
    }, 'CLAUDE.md'));

    // One entry, not two: the map is keyed by path, and §6.1 sums over identities.
    expect(map.get('shared.md')).toEqual({ depth: 2, viaPath: 'a.md' });
  });

  it('terminates on a cycle', () => {
    const map = closureProvenance(inputFor({
      'CLAUDE.md': '@a.md\n',
      'a.md': '@CLAUDE.md\n',
    }, 'CLAUDE.md'));

    // Code-point order, not `localeCompare`: the assertion pins a specific
    // string ordering ('CLAUDE.md' before 'a.md'), and locale collation would
    // reorder it case-insensitively.
    expect([...map.keys()].sort((left, right) => (left < right ? -1 : 1))).toEqual(['CLAUDE.md', 'a.md']);
  });

  it('refuses a declaration carrying refusal rules rather than answering approximately', () => {
    const base = inputFor({ 'CLAUDE.md': '@a.md\n', 'a.md': 'x\n' }, 'CLAUDE.md');
    const withRefusals: ClosureProvenanceInput = {
      ...base,
      declaration: { ...base.declaration, refusals: [{ basenames: ['a.md'], patterns: [], flags: {}, kinds: [], label: 'x', payload: null }] },
    };

    expect(() => closureProvenance(withRefusals)).toThrow(/refusals/);
  });
});
