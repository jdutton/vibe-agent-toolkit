/**
 * `TS_VERSION_SKEW`: one root-level `ts_import_conditions` row when a manifest declares a
 * `typescript` major other than the one VAT answers with. Pure: the pinned version is the loaded
 * module's `version`, passed in, so no version constant exists; the project's own `typescript` is
 * never loaded or read; the row never refuses a statement.
 */

import semver from 'semver';

import type { TsImportConditionRow } from '../schemas/projection-ts-resolve.js';
import type { WorkspaceDependencyRow } from '../schemas/projection-workspace.js';

/**
 * The major of a range's lowest version, or undefined when the range has none: a tag, garbage, or
 * any range that means every version (`''`, `*`, `x`, `X`, `*.*`, which `semver` normalizes to `*`).
 */
function declaredMajor(range: string): number | undefined {
  const valid = semver.validRange(range.trim());
  if (valid === null || valid === '*') {
    return undefined;
  }
  return semver.minVersion(valid)?.major;
}

/**
 * The skew row of one root, as a list of zero or one.
 *
 * @param root - The analysis root's id.
 * @param dependencies - `workspace_dependencies` rows (any root; other roots are ignored).
 * @param pinnedVersion - The loaded TypeScript module's `version`.
 */
export function versionSkewRows(
  root: string,
  dependencies: readonly WorkspaceDependencyRow[],
  pinnedVersion: string,
): TsImportConditionRow[] {
  const pinnedMajor = semver.parse(pinnedVersion)?.major;
  if (pinnedMajor === undefined) {
    return [];
  }
  const majors = new Set<number>();
  const differingMajors = new Set<number>();
  const differing = new Set<string>();
  for (const row of dependencies) {
    if (row.root !== root || row.name !== 'typescript' || row.protocol !== 'npm') {
      continue;
    }
    const major = declaredMajor(row.range);
    if (major === undefined) {
      continue;
    }
    majors.add(major);
    if (major !== pinnedMajor) {
      differing.add(row.path);
      differingMajors.add(major);
    }
  }
  if (differing.size === 0) {
    return [];
  }
  const ascending = (values: ReadonlySet<number>): string => [...values].sort((a, b) => a - b).join(',');
  const declaredMajors = ascending(majors);
  return [{
    root,
    config: null,
    path: null,
    ordinal: null,
    code: 'TS_VERSION_SKEW',
    message: `VAT resolves imports with TypeScript ${pinnedMajor}.x; ${differing.size} manifest(s) declare typescript major ${ascending(differingMajors)}, which may resolve differently under the project's own compiler`,
    pinnedMajor,
    declaredMajors,
    manifests: differing.size,
  }];
}
