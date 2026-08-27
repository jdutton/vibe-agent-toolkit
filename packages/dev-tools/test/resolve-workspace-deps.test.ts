/**
 * `workspace:*` must not survive into a published manifest.
 *
 * npm rejects the protocol outright — `EUNSUPPORTEDPROTOCOL: Unsupported URL
 * Type "workspace:"` — so a single leaked specifier makes the whole package
 * uninstallable for every npm and npx user. Bun understands `workspace:`, which
 * is what let this ship: `bun add` of the broken tarball succeeds, so a
 * bun-only smoke test cannot see the defect at all.
 *
 * Shipped as `@vibe-agent-toolkit/cli@0.2.0-rc.3`, whose `optionalDependencies`
 * carried three raw `workspace:*` entries (`projection-sqlite`, `rag`,
 * `rag-lancedb`) because the resolver enumerated three dependency fields by
 * hand and `optionalDependencies` was not among them. `0.1.42` and
 * `0.2.0-rc.2` were clean — the field had no entries then, so the omission was
 * latent until a package used it.
 */

import { describe, expect, it } from 'vitest';

import {
  DEPENDENCY_FIELDS,
  resolveWorkspaceDependencies,
  type PackageJson,
} from '../src/resolve-workspace-deps.js';

const VERSION = '9.9.9';
const FIRST_PARTY = '@vibe-agent-toolkit/rag';
const WORKSPACE = 'workspace:*';

/** A manifest carrying one `workspace:*` entry in the named field. */
function manifestWith(field: (typeof DEPENDENCY_FIELDS)[number]): PackageJson {
  return {
    name: '@vibe-agent-toolkit/example',
    version: VERSION,
    [field]: { [FIRST_PARTY]: WORKSPACE },
  };
}

describe('resolveWorkspaceDependencies', () => {
  it.each(DEPENDENCY_FIELDS)('rewrites workspace:* in %s', (field) => {
    const packageJson = manifestWith(field);

    const resolved = resolveWorkspaceDependencies(packageJson, VERSION);

    expect(resolved).toBe(1);
    expect(packageJson[field]?.[FIRST_PARTY]).toBe(VERSION);
  });

  it('covers every npm manifest field that can carry a dependency', () => {
    // Pinned as a SET, not a count and not a sorted list: order is irrelevant
    // to correctness, and a count alone would pass for any four names.
    expect(new Set(DEPENDENCY_FIELDS)).toEqual(
      new Set(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']),
    );
  });

  it('leaves a non-workspace specifier untouched', () => {
    const packageJson: PackageJson = {
      name: '@vibe-agent-toolkit/example',
      version: VERSION,
      optionalDependencies: { [FIRST_PARTY]: '^1.0.0', zod: WORKSPACE },
    };

    const resolved = resolveWorkspaceDependencies(packageJson, VERSION);

    // `zod` is out of scope even though it carries the protocol: only
    // first-party packages are rewritten, so an unscoped `workspace:*` is left
    // for the caller to notice rather than silently given our version.
    expect(resolved).toBe(0);
    expect(packageJson.optionalDependencies?.[FIRST_PARTY]).toBe('^1.0.0');
    expect(packageJson.optionalDependencies?.['zod']).toBe(WORKSPACE);
  });
});
