/**
 * `okf.bundles` → validator runs.
 *
 * The translation lives here rather than in the CLI command so it can be
 * unit-tested against the config schema's real types, and so a second entry
 * point (a `vat validate` phase, say) reaches the same rules instead of
 * restating them.
 */

import { compareCodeUnits, resolveAssetReference } from '@vibe-agent-toolkit/utils';

import type { OkfConfig } from '../schemas/project-config.js';

import type { ValidateOkfBundleOptions } from './validate.js';

/** What narrows or parameterises a set of runs. */
export interface OkfBundleRunOptions {
  /** Validate only this declared bundle. Absent means every declared bundle. */
  bundle?: string;
  /** The OKF revision to cross-check a declared `okf_version` against (§12). */
  specVersion?: string;
}

/** The error an undeclared bundle name earns, naming what IS declared. */
function unknownBundleError(requested: string, declared: string[]): Error {
  const known = declared.length === 0
    ? 'this project declares no okf.bundles at all'
    : `declared bundles: ${declared.join(', ')}`;
  return new Error(`No OKF bundle named '${requested}' in okf.bundles — ${known}.`);
}

/**
 * Build one validator run per declared bundle.
 *
 * ⛔ There is no include/exclude to translate, and adding one later would be a
 * defect rather than a convenience — see the `OkfBundleConfigSchema` docstring.
 * A bundle's population is spec-defined; a glob that matched fewer files would
 * let VAT certify a bundle while a file it never read broke conformance.
 *
 * `root` goes through `resolveAssetReference` like every other config-supplied
 * location, so an adopter can point a bundle at a subtree published as an npm
 * package without hardcoding that package's internal layout.
 *
 * @param okf - The project's `okf` section, or undefined if it declares none
 * @param baseDir - Absolute directory holding the config file; roots resolve against it
 * @param options - Narrow to one bundle, and/or supply a revision to cross-check
 * @returns Runs, ordered by bundle name
 * @throws If `options.bundle` names a bundle the project does not declare
 */
export function okfBundleRuns(
  okf: OkfConfig | undefined,
  baseDir: string,
  options: OkfBundleRunOptions = {},
): ValidateOkfBundleOptions[] {
  const declared = Object.keys(okf?.bundles ?? {}).sort(compareCodeUnits);

  if (options.bundle !== undefined && !declared.includes(options.bundle)) {
    throw unknownBundleError(options.bundle, declared);
  }

  const selected = options.bundle === undefined ? declared : [options.bundle];

  return selected.map((bundle) => {
    const config = okf?.bundles[bundle];
    if (config === undefined) {
      // Unreachable via `declared`; kept so the type narrows without a cast.
      throw unknownBundleError(bundle, declared);
    }
    return {
      bundle,
      root: resolveAssetReference(config.root, baseDir),
      ...(config.severity !== undefined && { severity: config.severity }),
      ...(options.specVersion !== undefined && { specVersion: options.specVersion }),
    };
  });
}
