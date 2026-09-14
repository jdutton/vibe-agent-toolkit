/**
 * `tsconfig.json` `references` are derived from `package.json`; nothing types
 * them in. The planner cases pin WHICH packages get a reference (every
 * TypeScript project from the root; every workspace dependency of any kind
 * from a package), the renderer cases pin the byte shape `--check` compares,
 * and the last case pins the real tree: it is what the gate asserts.
 */

import { describe, expect, it } from 'vitest';

import { PROJECT_ROOT } from '../src/common.js';
import {
  findStaleTsconfigs,
  formatTsconfig,
  planTsconfigReferences,
  renderTsconfig,
} from '../src/generate-tsconfig-refs.js';
import type { WorkspaceGraph, WorkspacePackage } from '../src/workspace-graph.js';

/** A graph built in memory; `isTypeScriptProject` is answered by `scripts.build` alone here. */
function graphOf(
  specs: Array<{ dir: string; deps?: string[]; devDeps?: string[]; build?: boolean }>,
): WorkspaceGraph {
  const packages: WorkspacePackage[] = specs.map((spec) => ({
    dir: spec.dir,
    name: `@scope/${spec.dir}`,
    isPrivate: false,
    manifest: spec.build === false ? {} : { scripts: { build: 'tsc' } },
    workspaceDeps: {
      runtime: (spec.deps ?? []).map((dep) => `@scope/${dep}`),
      dev: (spec.devDeps ?? []).map((dep) => `@scope/${dep}`),
    },
  }));
  return { packages, byName: new Map(packages.map((pkg) => [pkg.name, pkg])) };
}

describe('planTsconfigReferences', () => {
  // The planner asks the filesystem whether each package has a tsconfig.json,
  // so the fixture graph is planned against the REAL packages/ directory: a
  // fixture `dir` that names a real package reads as a project, any other
  // name reads as "no tsconfig" and is left out.
  const graph = graphOf([
    { dir: 'utils' },
    { dir: 'schema', devDeps: ['utils'] },
    { dir: 'cli', deps: ['schema', 'utils', 'nope'] },
    { dir: 'nope' },
  ]);
  const plans = planTsconfigReferences(PROJECT_ROOT, graph);

  it('references every TypeScript project from the root, by directory order', () => {
    expect(plans[0]).toEqual({
      relPath: 'tsconfig.json',
      references: ['./packages/cli', './packages/schema', './packages/utils'],
    });
  });

  it('gives each project its workspace dependencies of every kind, and only projects', () => {
    const byPath = new Map(plans.map((plan) => [plan.relPath, plan.references] as const));
    expect(byPath.get('packages/cli/tsconfig.json')).toEqual(['../schema', '../utils']);
    // A dev-only dependency still orders the build.
    expect(byPath.get('packages/schema/tsconfig.json')).toEqual(['../utils']);
    expect(byPath.get('packages/utils/tsconfig.json')).toEqual([]);
    // Not a project (no tsconfig on disk): never planned, never referenced.
    expect(byPath.has('packages/nope/tsconfig.json')).toBe(false);
  });
});

describe('renderTsconfig', () => {
  const original = [
    '{',
    '  "extends": "../../tsconfig.base.json",',
    '  "compilerOptions": { "composite": true, "outDir": "./dist" },',
    '  "include": ["src/**/*"],',
    '  "references": [{ "path": "../stale" }]',
    '}',
    '',
  ].join('\n');

  it('rewrites only the references key and keeps everything else', () => {
    const rendered = renderTsconfig(original, { relPath: 'x', references: ['../a', '../b'] });

    expect(rendered).toBe(
      [
        '{',
        '  "extends": "../../tsconfig.base.json",',
        '  "compilerOptions": {',
        '    "composite": true,',
        '    "outDir": "./dist"',
        '  },',
        '  "include": ["src/**/*"],',
        '  "references": [',
        '    { "path": "../a" },',
        '    { "path": "../b" }',
        '  ]',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('removes the key entirely for a package with no workspace dependencies', () => {
    const rendered = renderTsconfig(original, { relPath: 'x', references: [] });

    expect(rendered).not.toContain('references');
    expect(JSON.parse(rendered)).toEqual({
      extends: '../../tsconfig.base.json',
      compilerOptions: { composite: true, outDir: './dist' },
      include: ['src/**/*'],
    });
  });

  it('is idempotent: rendering its own output changes nothing', () => {
    const plan = { relPath: 'x', references: ['../a'] };
    const once = renderTsconfig(original, plan);

    expect(renderTsconfig(once, plan)).toBe(once);
  });
});

describe('formatTsconfig', () => {
  it('keeps scalar arrays and nested option objects readable', () => {
    const text = formatTsconfig({
      compilerOptions: { plugins: [{ transform: '@x/y' }], types: ['node', 'vitest/globals'] },
      exclude: ['node_modules', 'dist'],
    });

    expect(text).toContain('"types": ["node", "vitest/globals"]');
    expect(text).toContain('"exclude": ["node_modules", "dist"]');
    // An object inside an array is not a `{ path }` entry and stays expanded.
    expect(text).toContain('"plugins": [\n      {\n        "transform": "@x/y"\n      }\n    ]');
  });
});

describe('the real tree', () => {
  it('has every tsconfig.json in the state `bun run generate:tsconfig-refs` produces', () => {
    // The gate assertion. A `package.json` dependency edit that forgets the
    // tsconfig fails here — the mechanism the twelve stale files were missing.
    expect(findStaleTsconfigs(PROJECT_ROOT).map((file) => file.relPath)).toEqual([]);
  });
});
