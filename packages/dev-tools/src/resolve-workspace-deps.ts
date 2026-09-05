#!/usr/bin/env tsx
/* eslint-disable security/detect-non-literal-fs-filename */
// File paths derived from PACKAGES_DIR constant (controlled directory scanning)

/**
 * resolve-workspace-deps.ts
 *
 * Resolves workspace:* dependencies to actual versions before publishing to npm.
 *
 * Why: npm publish doesn't understand Bun's workspace:* protocol. Only bun publish
 * handles this automatically, but bun doesn't support --provenance flag needed for
 * supply chain security.
 *
 * Solution: This script replaces workspace:* with actual versions from the packages
 * being published. It modifies package.json files in-place, so it should only be
 * run in CI or in a temp directory, never on git-tracked files during development.
 *
 * Usage:
 *   bun run resolve-workspace-deps <version>
 *
 * Example:
 *   bun run resolve-workspace-deps 0.1.0-rc.7
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';

import { log } from './common.js';

const PACKAGES_DIR = safePath.join(import.meta.dirname, '../../../packages');
const SCOPE = '@vibe-agent-toolkit';

export interface PackageJson {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/**
 * Every npm manifest field that can carry a `workspace:*` specifier.
 *
 * Declared ONCE and iterated, rather than enumerated at the call site. The call
 * site listed three of the four, and `optionalDependencies` was the omission —
 * invisible while no package used the field, and shipped the moment one did:
 * `@vibe-agent-toolkit/cli@0.2.0-rc.3` published `projection-sqlite`, `rag` and
 * `rag-lancedb` as raw `workspace:*`, which npm rejects with
 * `EUNSUPPORTEDPROTOCOL` and bun silently accepts. A list nobody has to
 * remember to extend cannot acquire that hole again.
 */
export const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

/**
 * Rewrite every first-party `workspace:*` specifier in a manifest to `version`.
 *
 * Mutates `packageJson` in place.
 *
 * 🚨 **Throws on any `workspace:` specifier it did not rewrite, and that
 * post-condition is the actual guard.** {@link DEPENDENCY_FIELDS} closed the
 * axis that produced v0.2.0-rc.3 — a field nobody remembered to list — and left
 * the other one open: {@link resolveDependencies} matches the exact string
 * `workspace:*` and nothing else, so `workspace:^`, `workspace:~` and
 * `workspace:0.2.0` pass through untouched. Nothing downstream noticed:
 * `publish.yml` runs this and publishes, and `pre-publish-check`'s workspace
 * step COUNTS specifiers without ever failing on one.
 *
 * `workspace:^` is not exotic — it is the natural thing to write for a **peer**
 * range, which is the field this release introduces. npm rejects a published
 * `workspace:` with `EUNSUPPORTEDPROTOCOL`, making the release uninstallable;
 * bun understands the protocol and hides it, and this repo uses bun everywhere,
 * so the one tool that would catch it is the one nothing runs.
 *
 * So the check is on the OUTCOME rather than on the inputs believed to produce
 * it: after the rewrite, no first-party `workspace:` may remain, whatever form
 * it was written in. A future edit that adds a supported form makes this pass by
 * handling it, not by being remembered.
 *
 * @param packageJson - The parsed manifest to rewrite
 * @param version - The concrete version to substitute
 * @returns How many specifiers were rewritten
 * @throws When any `workspace:` specifier survives the rewrite
 */
export function resolveWorkspaceDependencies(packageJson: PackageJson, version: string): number {
  let resolved = 0;
  for (const field of DEPENDENCY_FIELDS) {
    resolved += resolveDependencies(packageJson[field], version);
  }
  assertNoWorkspaceSpecifiers(packageJson);
  return resolved;
}

/**
 * Refuse a manifest still carrying a `workspace:` specifier after the rewrite.
 *
 * Reads EVERY field in {@link DEPENDENCY_FIELDS} and reports all survivors at
 * once — a publish that fails on one specifier, gets it fixed, and fails on the
 * next is three CI runs to learn one thing.
 *
 * It does not filter on {@link SCOPE}. A third-party `workspace:` specifier is
 * just as uninstallable, and this is the last place anything looks.
 *
 * @param packageJson - The manifest, after rewriting
 * @throws When any specifier still begins `workspace:`
 */
function assertNoWorkspaceSpecifiers(packageJson: PackageJson): void {
  const survivors: string[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    for (const [dep, spec] of Object.entries(packageJson[field] ?? {})) {
      if (spec.startsWith('workspace:')) survivors.push(`${field}.${dep} = "${spec}"`);
    }
  }
  if (survivors.length === 0) return;

  throw new Error(
    `${packageJson.name} still carries ${survivors.length} workspace specifier(s) after the`
    + ` rewrite:\n  ${survivors.join('\n  ')}\n`
    + '\nOnly the exact string `workspace:*` is rewritten. npm refuses any other form at install'
    + ' time with EUNSUPPORTEDPROTOCOL — and bun accepts it silently, so publishing this would'
    + ' ship a release that is uninstallable under npm and looks fine here. Write `workspace:*`,'
    + ' or teach this script the form you need.',
  );
}

function resolveDependencies(deps: Record<string, string> | undefined, version: string): number {
  if (!deps) return 0;

  let resolved = 0;
  for (const [dep, currentVersion] of Object.entries(deps)) {
    if (dep.startsWith(SCOPE) && currentVersion === 'workspace:*') {
      deps[dep] = version;
      resolved++;
    }
  }
  return resolved;
}

function processPackage(packageDir: string, version: string): number {
  const packageJsonPath = safePath.join(PACKAGES_DIR, packageDir, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageJson;

  const resolved = resolveWorkspaceDependencies(packageJson, version);

  if (resolved > 0) {
    writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
    log(`  ✓ ${packageJson.name}: Resolved ${resolved} workspace dependencies to ${version}`, 'green');
  }

  return resolved;
}

function getAllPackageDirs(): string[] {
  return readdirSync(PACKAGES_DIR).filter((dir) => {
    const fullPath = safePath.join(PACKAGES_DIR, dir);
    const isDirectory = statSync(fullPath).isDirectory();
    if (!isDirectory) return false;
    const hasPackageJson = readdirSync(fullPath).includes('package.json');
    return hasPackageJson;
  });
}

function main(): void {
  const version = process.argv[2];

  if (!version) {
    log('❌ Error: Version argument required', 'red');
    console.log('Usage: bun run resolve-workspace-deps <version>');
    console.log('Example: bun run resolve-workspace-deps 0.1.0-rc.7');
    process.exit(1);
  }

  log(`\n🔧 Resolving workspace:* dependencies to ${version}...`, 'blue');

  const packageDirs = getAllPackageDirs();
  let totalResolved = 0;

  for (const packageDir of packageDirs) {
    totalResolved += processPackage(packageDir, version);
  }

  log(`\n✅ Resolved ${totalResolved} total workspace dependencies to ${version}`, 'green');
}

// Only when RUN, never when imported. Unguarded, `main()` fired on import and
// `process.exit(1)`d on the missing version argument, so the module could not be
// unit tested at all — which is why the `optionalDependencies` hole shipped
// untested. A test that cannot import the thing it tests is not a test.
const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  main();
}
