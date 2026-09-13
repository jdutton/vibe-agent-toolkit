/**
 * `okf.bundles` → validator runs.
 *
 * The translation lives here rather than in the CLI command so it can be
 * unit-tested against the config schema's real types, and so a second entry
 * point (a `vat validate` phase, say) reaches the same rules instead of
 * restating them.
 */

import { compareCodeUnits, resolveAssetReference, safePath } from '@vibe-agent-toolkit/utils';

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
 * Locate one declared bundle root, without ever throwing on adopter config.
 *
 * `root` goes through {@link resolveAssetReference} because that is the one
 * resolver every config-supplied location in VAT goes through, and because its
 * ordinary answer — a path resolved against the config file's directory — is
 * the form every real bundle root takes.
 *
 * ⛔ **What it is NOT is a way to point a bundle at an npm-published subtree,
 * and this docstring used to say it was.** A bundle root is a DIRECTORY, and
 * npm resolution answers with a FILE: `require.resolve` walks the target
 * package's `exports` map to a module, never to a subtree. A specifier that
 * resolves therefore hands this lane a file path, and the very next thing that
 * happens to it is a `readdir` that fails `ENOTDIR`. There is no shape of
 * `exports` that makes the claim true.
 *
 * 🪤 **And a specifier that does NOT resolve used to throw out of the whole
 * run.** `resolveAssetReference` has a path fallback for an unscoped bare
 * specifier (`ops/playbooks` with no installed `ops` package) and deliberately
 * none for a scoped one, so `@scope/pkg/bundle` rethrew — killing `vat okf
 * validate` at exit 2, discarding every other declared bundle's findings, and
 * printing `run install in <baseDir>`, i.e. the developer's `$HOME`, into the
 * CI log. Adopter config is user data; user data reaching a programming-error
 * throw is the defect, and this lane already answers it the same way three
 * times over — `OKF_BUNDLE_ROOT_UNREADABLE`, `OKF_SUBDIRECTORY_UNREADABLE` and
 * `OKF_DOCUMENT_UNREADABLE` are all findings that were once throws.
 *
 * So every resolution failure degrades to the same plain path resolution the
 * unscoped fallback already performs. The root then does not exist, and
 * `validateOkfBundle` reports `OKF_BUNDLE_ROOT_UNREADABLE` naming the specifier
 * the adopter typed and the remedy for it — one bundle's finding, with the rest
 * of the run intact.
 *
 * @param specifier - The `okf.bundles.<name>.root` value, exactly as written
 * @param baseDir - Absolute directory holding the config file
 * @returns An absolute path to try to list — never a throw
 */
function resolveBundleRoot(specifier: string, baseDir: string): string {
  try {
    return resolveAssetReference(specifier, baseDir);
  } catch {
    return safePath.resolve(baseDir, specifier);
  }
}

/**
 * Build one validator run per declared bundle.
 *
 * ⛔ There is no include/exclude to translate, and adding one later would be a
 * defect rather than a convenience — see the `OkfBundleConfigSchema` docstring.
 * A bundle's population is spec-defined; a glob that matched fewer files would
 * let VAT certify a bundle while a file it never read broke conformance.
 *
 * Roots are located by {@link resolveBundleRoot}, which cannot throw: a root
 * nothing answers to is this bundle's own finding, never the run's exit code.
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
      root: resolveBundleRoot(config.root, baseDir),
      // Carried verbatim so the unreadable-root finding can quote the string the
      // adopter actually has to edit, rather than an absolute path that appears
      // nowhere in their repository (and would leak $HOME into a CI log).
      rootSpecifier: config.root,
      ...(config.severity !== undefined && { severity: config.severity }),
      ...(options.specVersion !== undefined && { specVersion: options.specVersion }),
    };
  });
}
