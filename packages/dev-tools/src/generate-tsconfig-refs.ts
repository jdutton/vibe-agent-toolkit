#!/usr/bin/env tsx
/**
 * Derive every `tsconfig.json` `references` list from `package.json`.
 *
 * The root `tsconfig.json` references every TypeScript project under
 * `packages/` (a package with a `tsconfig.json` AND a `build` script), and each
 * project references the workspace packages it declares in ANY dependency
 * field. Dev dependencies count: `vat-development-agents` compiles through a
 * transformer shipped by `resource-compiler`, which it lists as a devDependency,
 * so `tsc --build` must build that first. A reference to a package `src/` never
 * imports costs one extra ordering edge; a missing one is a build that reads a
 * stale or absent `dist/`.
 *
 * Usage:
 *   bun run --cwd packages/dev-tools generate:tsconfig-refs           # rewrite every tsconfig's references
 *   bun run --cwd packages/dev-tools generate:tsconfig-refs --check   # exit 1 if any tsconfig is stale
 *
 * `--check` is what `validate-structure` runs, so a `package.json` edit that
 * forgets the tsconfig fails the gate instead of building against the previous
 * graph.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { ExitCode, type ExitCodeValue } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';

import { isEntrypoint, log, PROJECT_ROOT } from './common.js';
import {
  isTypeScriptProject,
  readWorkspaceGraph,
  workspaceDependenciesOf,
  type WorkspaceGraph,
  type WorkspacePackage,
} from './workspace-graph.js';

const TSCONFIG = 'tsconfig.json';

/** One tsconfig and the `references` it should carry, as `{ path }` entries. */
export interface TsconfigReferencePlan {
  /** Repo-relative path of the tsconfig. */
  readonly relPath: string;
  /** The reference paths, in the order they should appear. */
  readonly references: readonly string[];
}

/**
 * The plan for every tsconfig the graph owns: the root plus one per project.
 *
 * @param repoRoot - Absolute path of the monorepo root
 * @param graph - The workspace graph (read once by the caller)
 * @returns One plan per tsconfig, root first, then packages by directory
 */
export function planTsconfigReferences(repoRoot: string, graph: WorkspaceGraph): TsconfigReferencePlan[] {
  const projects = graph.packages
    .filter((pkg) => isTypeScriptProject(pkg, repoRoot))
    .sort((a, b) => a.dir.localeCompare(b.dir));
  const projectDirs = new Set(projects.map((pkg) => pkg.dir));

  const root: TsconfigReferencePlan = {
    relPath: TSCONFIG,
    references: projects.map((pkg) => `./packages/${pkg.dir}`),
  };

  const perPackage = projects.map((pkg: WorkspacePackage): TsconfigReferencePlan => ({
    relPath: `packages/${pkg.dir}/${TSCONFIG}`,
    references: workspaceDependenciesOf(pkg, graph)
      .filter((dep) => projectDirs.has(dep.dir))
      .map((dep) => `../${dep.dir}`),
  }));

  return [root, ...perPackage];
}

/**
 * Pretty-print a tsconfig the way this repo writes them by hand: two-space
 * indent, arrays of scalars on one line, and each reference entry on one line.
 * A single canonical shape is what lets `--check` be a byte comparison.
 */
export function formatTsconfig(config: Record<string, unknown>): string {
  const pretty = JSON.stringify(config, null, 2);
  const scalar = String.raw`(?:"(?:[^"\\]|\\.)*"|true|false|-?\d+(?:\.\d+)?)`;
  // eslint-disable-next-line security/detect-non-literal-regexp -- assembled from a module constant, never from input
  const scalarArray = new RegExp(String.raw`\[\n\s+(${scalar}(?:,\n\s+${scalar})*)\n\s+\]`, 'g');
  return (
    pretty
      .replaceAll(scalarArray, (_match, body: string) => `[${body.replaceAll(/,\n\s+/g, ', ')}]`)
      .replaceAll(/\{\n\s+"path": ("(?:[^"\\]|\\.)*")\n\s+\}/g, '{ "path": $1 }') + '\n'
  );
}

/**
 * The text `relPath` should hold once its references follow `plan`.
 *
 * Everything else in the file is preserved: the generator owns ONE key. An
 * empty plan removes the key rather than writing `"references": []`, which is
 * how a package with no workspace dependencies is written by hand.
 */
export function renderTsconfig(currentText: string, plan: TsconfigReferencePlan): string {
  const config = JSON.parse(currentText) as Record<string, unknown>;
  if (plan.references.length === 0) {
    delete config['references'];
  } else {
    config['references'] = plan.references.map((path) => ({ path }));
  }
  return formatTsconfig(config);
}

/** A tsconfig whose committed text differs from what the generator would write. */
export interface StaleTsconfig {
  readonly relPath: string;
  readonly expected: string;
}

/**
 * Every tsconfig that is not in the state the generator produces.
 *
 * @param repoRoot - Absolute path of the monorepo root
 * @returns The stale files, with the text they should hold
 */
export function findStaleTsconfigs(repoRoot: string): StaleTsconfig[] {
  const graph = readWorkspaceGraph(repoRoot);
  const stale: StaleTsconfig[] = [];
  for (const plan of planTsconfigReferences(repoRoot, graph)) {
    const current = readFileSync(safePath.join(repoRoot, plan.relPath), 'utf8');
    const expected = renderTsconfig(current, plan);
    if (current !== expected) stale.push({ relPath: plan.relPath, expected });
  }
  return stale;
}

function main(argv: readonly string[]): ExitCodeValue {
  const check = argv.includes('--check');
  const stale = findStaleTsconfigs(PROJECT_ROOT);

  if (stale.length === 0) {
    log('✓ Every tsconfig.json references list matches package.json', 'green');
    return ExitCode.OK;
  }

  if (check) {
    log(`✗ ${stale.length} tsconfig.json file(s) disagree with package.json:`, 'red');
    for (const file of stale) log(`    ${file.relPath}`, 'red');
    log('  Regenerate with: bun run --cwd packages/dev-tools generate:tsconfig-refs', 'yellow');
    return ExitCode.FINDINGS;
  }

  for (const file of stale) {
    writeFileSync(safePath.join(PROJECT_ROOT, file.relPath), file.expected, 'utf8');
    log(`  ✓ ${file.relPath}`, 'green');
  }
  log(`✓ Rewrote ${stale.length} tsconfig.json file(s) from package.json`, 'green');
  return ExitCode.OK;
}

if (isEntrypoint(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
