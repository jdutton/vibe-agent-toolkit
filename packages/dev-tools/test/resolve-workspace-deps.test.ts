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
/** The manifest name every fixture here carries. */
const PKG = '@vibe-agent-toolkit/example';
/** The caret form — the realistic way an unrewritten specifier gets written. */
const CARET = 'workspace:^';
const FIRST_PARTY = '@vibe-agent-toolkit/rag';
const WORKSPACE = 'workspace:*';

/** A manifest carrying one `workspace:*` entry in the named field. */
function manifestWith(field: (typeof DEPENDENCY_FIELDS)[number]): PackageJson {
  return {
    name: PKG,
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
      name: PKG,
      version: VERSION,
      optionalDependencies: { [FIRST_PARTY]: '^1.0.0' },
    };

    const resolved = resolveWorkspaceDependencies(packageJson, VERSION);

    expect(resolved).toBe(0);
    expect(packageJson.optionalDependencies?.[FIRST_PARTY]).toBe('^1.0.0');
  });
});

/**
 * The POST-CONDITION, which is a different guard from the field list above.
 *
 * 🚨 `DEPENDENCY_FIELDS` closed the axis that shipped rc.3 — a field nobody
 * remembered to list. It left the other axis open: the rewrite matches the
 * exact string `workspace:*`, so every OTHER form of the protocol passed
 * straight through, and nothing downstream looked. `publish.yml` runs the
 * rewrite and publishes; `pre-publish-check`'s workspace step counts specifiers
 * and never fails on one.
 *
 * ⭐ These tests assert the ANSWER — "no `workspace:` survives" — rather than
 * the input believed to produce it. That is the distinction the rc.3 fix missed:
 * a test that the field list is complete stays green while a specifier FORM it
 * cannot rewrite sails past.
 */
describe('resolveWorkspaceDependencies post-condition', () => {
  // Every form bun accepts that is NOT the one literal the rewrite matches.
  // `workspace:^` is the realistic one: it is what a person writes for a PEER
  // range, and peers are the field this release introduces.
  const UNREWRITTEN = [CARET, 'workspace:~', 'workspace:0.2.0', 'workspace:*.*'] as const;

  it.each(UNREWRITTEN)('refuses %s rather than publishing it', (spec) => {
    const packageJson: PackageJson = {
      name: PKG,
      version: VERSION,
      peerDependencies: { [FIRST_PARTY]: spec },
    };

    expect(() => resolveWorkspaceDependencies(packageJson, VERSION))
      .toThrow(/still carries 1 workspace specifier/);
  });

  it('names the package, the field and the specifier, so one CI run fixes it', () => {
    const packageJson: PackageJson = {
      name: PKG,
      version: VERSION,
      peerDependencies: { [FIRST_PARTY]: CARET },
    };

    expect(() => resolveWorkspaceDependencies(packageJson, VERSION))
      .toThrow(/@vibe-agent-toolkit\/example[\S\s]*peerDependencies\.@vibe-agent-toolkit\/rag/);
  });

  it('reports EVERY survivor at once rather than one per publish attempt', () => {
    const packageJson: PackageJson = {
      name: PKG,
      version: VERSION,
      dependencies: { [FIRST_PARTY]: CARET },
      peerDependencies: { '@vibe-agent-toolkit/utils': 'workspace:~' },
    };

    expect(() => resolveWorkspaceDependencies(packageJson, VERSION))
      .toThrow(/still carries 2 workspace specifier/);
  });

  it('refuses a THIRD-PARTY workspace specifier too', () => {
    // 🪤 This is the case whose old test said an unscoped `workspace:*` was
    // "left for the caller to notice". Nobody was noticing — this function is
    // the last thing that looks at the manifest before `npm publish`, and npm
    // rejects `workspace:` whoever declared it. Being out of SCOPE decides
    // whether it is REWRITTEN, never whether it may SHIP.
    const packageJson: PackageJson = {
      name: PKG,
      version: VERSION,
      dependencies: { zod: WORKSPACE },
    };

    expect(() => resolveWorkspaceDependencies(packageJson, VERSION)).toThrow(/zod/);
  });

  it('passes a manifest with no workspace specifiers at all', () => {
    const packageJson: PackageJson = {
      name: PKG,
      version: VERSION,
      dependencies: { [FIRST_PARTY]: WORKSPACE, zod: '^3.24.1' },
    };

    expect(resolveWorkspaceDependencies(packageJson, VERSION)).toBe(1);
  });
});
