import { describe, expect, it } from 'vitest';

import { versionSkewRows } from '../src/projection/ts-version-skew.js';
import type { WorkspaceDependencyRow, WorkspaceProtocol } from '../src/schemas/projection-workspace.js';

const PREFIX_PROTOCOLS: ReadonlyArray<readonly [string, WorkspaceProtocol]> = [
  ['workspace:', 'workspace'], ['catalog:', 'catalog'], ['link:', 'link'], ['file:', 'file'],
];

function dep(path: string, range: string, over: Partial<WorkspaceDependencyRow> = {}): WorkspaceDependencyRow {
  const protocol = PREFIX_PROTOCOLS.find(([prefix]) => range.startsWith(prefix))?.[1] ?? 'npm';
  return { root: '.', path, field: 'devDependencies', name: 'typescript', range, targetPath: null, protocol, ...over };
}

/** A stand-in for the loaded module: only its `version` is read. */
const pinned = (version: string): string => version;

describe('versionSkewRows', () => {
  it('reports one row when a manifest declares another major', () => {
    const rows = versionSkewRows('.', [dep('package.json', '^5.9.3')], pinned('6.0.3'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      root: '.', config: null, path: null, ordinal: null, code: 'TS_VERSION_SKEW',
      pinnedMajor: 6, declaredMajors: '5', manifests: 1,
    });
    expect(rows[0]?.message).toContain('5');
  });

  it('reads the pinned major from the version it is given, never a constant', () => {
    const rows = versionSkewRows('.', [dep('package.json', '^6.0.0')], pinned('7.1.0'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pinnedMajor: 7, declaredMajors: '6', manifests: 1 });
  });

  it('reports nothing when every declaration matches', () => {
    expect(versionSkewRows('.', [dep('package.json', '^6.0.0')], pinned('6.0.3'))).toEqual([]);
  });

  it('reports one row for two manifests on 5 and 6, counting the differing one', () => {
    const rows = versionSkewRows('.', [dep('package.json', '^6.0.0'), dep('a/package.json', '~5.4.0')], pinned('6.0.3'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ declaredMajors: '5,6', manifests: 1 });
  });

  it('lists distinct majors ascending and counts each differing manifest once', () => {
    const rows = versionSkewRows('.', [
      dep('b/package.json', '^5.0.0'), dep('b/package.json', '^5.1.0', { field: 'dependencies' }),
      dep('a/package.json', '^4.9.0'), dep('c/package.json', '^6.0.0'),
    ], pinned('6.0.3'));
    expect(rows[0]).toMatchObject({ declaredMajors: '4,5,6', manifests: 2 });
  });

  it('reads the lowest version of a range', () => {
    const rows = versionSkewRows('.', [dep('package.json', '>=5 <7')], pinned('6.0.3'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ declaredMajors: '5' });
  });

  it.each(['workspace:*', 'latest', 'catalog:', 'catalog:tools', 'link:../ts', 'file:../ts.tgz', 'not a range', ''])(
    'ignores %j', (range) => {
      expect(versionSkewRows('.', [dep('package.json', range)], pinned('6.0.3'))).toEqual([]);
    });

  it('ignores a catalog range even when its text parses', () => {
    const row = dep('package.json', '^5.0.0', { protocol: 'catalog' });
    expect(versionSkewRows('.', [row], pinned('6.0.3'))).toEqual([]);
  });

  it('reports nothing when no typescript is declared, and ignores other packages and other roots', () => {
    expect(versionSkewRows('.', [], pinned('6.0.3'))).toEqual([]);
    expect(versionSkewRows('.', [dep('package.json', '^5.0.0', { name: 'eslint' })], pinned('6.0.3'))).toEqual([]);
    expect(versionSkewRows('.', [dep('package.json', '^5.0.0', { root: 'other' })], pinned('6.0.3'))).toEqual([]);
  });

  it('never throws on an unparsable pinned version and reports nothing', () => {
    expect(versionSkewRows('.', [dep('package.json', '^5.0.0')], 'garbage')).toEqual([]);
  });
});
