/**
 * The ESLint usages the two ported `resources.checks` entries replaced, reconstructed for the proofs
 * that each check is exactly as strong as its usage: the deleted `selfImportConfigs()` blocks and
 * the deleted boundary block, laid over the repository's own flat config, and the names and
 * statements both tiers of the proof read. The corpus arms are in
 * `integration/check-ports.integration.test.ts`; the repository arm, a run of the built `vat` and a
 * lint over this whole repository, is in `system/check-ports-repository.system.test.ts`.
 */

import type { Linter } from 'eslint';

import { importEslintConfigSupport, localPlugin } from './check-port-differential.js';
import { importRootEslintConfig } from './eslint-clean-files.js';

/** A workspace package as the deleted block read one: its directory under `packages/`, and its name. */
export interface WorkspacePackage {
  readonly dir: string;
  readonly name: string;
}

export const SELF_RULE = 'local/no-self-package-import';
export const SELF_CHECK = { name: 'no-self-package-import', population: 'owned' } as const;
export const BOUNDARY_RULE = 'local/projection-sqlite-import-boundary';
export const BOUNDARY_CHECK = { name: 'projection-sqlite-import-boundary', population: 'enabled' } as const;
export const BACKEND = '@vibe-agent-toolkit/projection-sqlite';
/** The extensions the deleted boundary block named. */
export const SCRIPTS = '**/*.{ts,cts,mts,js,cjs,mjs}';

/** This repository's workspace packages, as `eslint.config.js` reads them. */
export const { workspacePackages } = await importEslintConfigSupport<{ readonly workspacePackages: () => WorkspacePackage[] }>();
const rootConfig = await importRootEslintConfig<{ readonly default: Linter.Config[] }>();
/** The repository's own flat config, loaded once: the deleted usage is laid over it. */
export const repoConfig: Linter.Config[] = rootConfig.default;
const localRules = localPlugin(repoConfig);

/** The deleted `selfImportConfigs()`, verbatim but for its package list: one block per package. */
export function selfImportBlocks(packages: readonly WorkspacePackage[]): Linter.Config[] {
  return packages.map(({ dir, name }) => ({
    files: [`packages/${dir}/src/**/*.ts`, `packages/${dir}/src/**/*.cts`],
    plugins: { local: localRules },
    rules: { [SELF_RULE]: ['error', { packageName: name }] },
  }));
}

/**
 * The ESLint glob a SQLite GLOB of the check's importer list stands for: a literal path is itself,
 * and a literal directory followed by `/*` (`*` crosses `/` in GLOB) is that directory's `/**`. Any
 * other shape is refused, so an entry the two languages read differently cannot pass unnoticed.
 */
function eslintGlobOf(glob: string): string {
  const META = /[*?[\]]/u;
  if (!META.test(glob)) return glob;
  const prefix = glob.slice(0, -2);
  if (glob.endsWith('/*') && !META.test(prefix)) return `${prefix}/**`;
  throw new Error(`The importer glob "${glob}" has no ESLint equivalent this proof knows; extend eslintGlobOf()`);
}

/** The deleted boundary block, verbatim but for its `ignores`: the check's importer list, as ESLint reads it. */
export function boundaryBlock(importers: readonly string[]): Linter.Config {
  return { files: [SCRIPTS], ignores: [...importers], plugins: { local: localRules }, rules: { [BOUNDARY_RULE]: 'error' } };
}

/** The importer globs the repository's own check declares, as ESLint reads them. */
export function importersOf(globs: readonly string[]): string[] {
  return globs.map((glob) => eslintGlobOf(glob));
}

/** The statements the boundary check's runs add to the population query: its importer globs, and every routed path. */
export const IMPORTERS_QUERY = { importers: 'SELECT glob AS v FROM importers' };
export const ROUTES_QUERY = { routed: 'SELECT path AS v FROM ts__routes' };

/** The boundary check's two finding arms, each's own findings as `path:line`, through the check's `with` text. */
export const BOUNDARY_ARMS_QUERY = {
  t1: 'SELECT b.path || \':\' || b.nodeLine AS v FROM backend_imports b JOIN enabled e ON e.root = b.root AND e.path = b.path',
  resolved: 'SELECT path || \':\' || nodeLine AS v FROM resolved_backend_imports',
} as const;

/** The resolved graph's own extent: its program files, and every file outside the backend that reaches into it. */
export const RESOLVED_GRAPH_QUERY = {
  programs: 'SELECT COUNT(*) AS v FROM ts_program_files',
  reaching: 'SELECT DISTINCT path AS v FROM ts_import_targets WHERE target GLOB \'packages/projection-sqlite/*\' AND path NOT GLOB \'packages/projection-sqlite/*\'',
} as const;
