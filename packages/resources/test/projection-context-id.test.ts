/**
 * The extent context-id scheme, and the federated collision it exists to stop.
 *
 * `resolution_contexts` is keyed on `contextId` **alone**, keep-first
 * (`ProjectionTable.add` returns the occupant and `addContext` reports `false`).
 * The package contributor originally spelled its ids `extent:package:<name>`,
 * with no root in them — so in a projection federating two roots that both
 * depend on one package, the second root's context row lost the key race and
 * was dropped, leaving that root's membership rows pointing at the *other*
 * root's extent. The last two tests here go red against that spelling.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- controlled temp fixture tree */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ExtentContribution } from '../src/projection/contributor.js';
import { extentContextId } from '../src/projection/contributors/context-id.js';
import { PackageExtentContributor } from '../src/projection/contributors/package-extent.js';
import { rootIdFor } from '../src/projection/identity.js';
import { ProjectionBuilder } from '../src/projection/projection.js';

/** Sentinel root ids, spelled the way `rootIdFor` spells them: `root-` + 32 hex. */
const ROOT_A = 'root-0123456789abcdef0123456789abcdef';
const ROOT_B = 'root-fedcba9876543210fedcba9876543210';

const PACKAGE_KIND = 'package';
const MANIFEST = 'package.json';

/** The one package name both fixture roots claim — the federated collision case. */
const SHARED_PACKAGE = '@fixture/shared';

let rootA: string;
let rootB: string;
let contributionA: ExtentContribution;
let contributionB: ExtentContribution;

/** A temp corpus whose own manifest names {@link SHARED_PACKAGE}. */
function makeRoot(): string {
  const directory = toForwardSlash(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-ctx-id-')));
  writeFileSync(
    safePath.join(directory, MANIFEST),
    JSON.stringify({ name: SHARED_PACKAGE, version: '0.0.0' }),
  );
  return directory;
}

/** The package extents of one corpus root. */
async function contribute(root: string): Promise<ExtentContribution> {
  return new PackageExtentContributor().contribute(new ProjectionBuilder(root).base(), {});
}

/** The context ids one contribution declared. */
function contextIdsOf(contribution: ExtentContribution): string[] {
  return contribution.contexts.map((row) => row.contextId);
}

beforeAll(async () => {
  rootA = makeRoot();
  rootB = makeRoot();
  contributionA = await contribute(rootA);
  contributionB = await contribute(rootB);
});

afterAll(() => {
  for (const directory of [rootA, rootB]) {
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe('extentContextId', () => {
  it('spells the same (kind, root) the same way on every call', () => {
    // The whole reason ids are derived and not allocated: two populations of
    // one corpus must name the same extent, or their zone_provenance digests
    // compare nothing.
    expect(extentContextId('filesystem', ROOT_A)).toBe(extentContextId('filesystem', ROOT_A));
    expect(extentContextId(PACKAGE_KIND, ROOT_A, SHARED_PACKAGE))
      .toBe(extentContextId(PACKAGE_KIND, ROOT_A, SHARED_PACKAGE));
  });

  it('separates two kinds under one root', () => {
    expect(extentContextId('filesystem', ROOT_A)).not.toBe(extentContextId('git', ROOT_A));
  });

  it('separates one root from another for the same kind', () => {
    expect(extentContextId('git', ROOT_A)).not.toBe(extentContextId('git', ROOT_B));
  });

  it('separates two packages under one root', () => {
    expect(extentContextId(PACKAGE_KIND, ROOT_A, 'react'))
      .not.toBe(extentContextId(PACKAGE_KIND, ROOT_A, 'react-dom'));
  });

  it('never spells a discriminated id the way it spells an undiscriminated one', () => {
    // A package extent and the (hypothetical) whole-root extent of the same
    // kind are different zones; an id that conflated them would merge them.
    expect(extentContextId(PACKAGE_KIND, ROOT_A, SHARED_PACKAGE))
      .not.toBe(extentContextId(PACKAGE_KIND, ROOT_A));
    // Even an empty discriminator stays distinguishable from its absence.
    expect(extentContextId(PACKAGE_KIND, ROOT_A, '')).not.toBe(extentContextId(PACKAGE_KIND, ROOT_A));
  });

  it('stays unambiguous for a discriminator carrying the id scheme own separators', () => {
    // Real npm names contain `/` and `-`, so the discriminator cannot be
    // assumed separator-free.
    expect(extentContextId(PACKAGE_KIND, ROOT_A, '@scope/pkg-name'))
      .not.toBe(extentContextId(PACKAGE_KIND, ROOT_A, '@scope/pkg'));
    // The case that decided the separator: with `-` joining the discriminator,
    // "kind `package`, root A, discriminator ROOT_B" and "kind `package-ROOT_A`,
    // root B, no discriminator" produce the same string. They must not.
    expect(extentContextId(PACKAGE_KIND, ROOT_A, ROOT_B))
      .not.toBe(extentContextId(`${PACKAGE_KIND}-${ROOT_A}`, ROOT_B));
  });
});

describe('federated roots depending on the same package', () => {
  it('mints two distinct root ids, so the fixture can tell the two answers apart', () => {
    // Negative control: if both temp roots hashed the same, every assertion
    // below would be about one root and could not fail.
    expect(rootIdFor(rootA)).not.toBe(rootIdFor(rootB));
  });

  it('gives each root its own extent for the shared package name', () => {
    const idsA = contextIdsOf(contributionA);
    const idsB = contextIdsOf(contributionB);

    // Non-vacuous: both roots really did declare an extent for this package.
    expect(idsA).toContain(extentContextId(PACKAGE_KIND, rootIdFor(rootA), SHARED_PACKAGE));
    expect(idsB).toContain(extentContextId(PACKAGE_KIND, rootIdFor(rootB), SHARED_PACKAGE));
    // Red against `extent:package:<name>`: the two lists would be identical.
    expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);
  });

  it('keeps both roots extents when they land in ONE federated projection', () => {
    // The failure this scheme exists to prevent, observed where it happens:
    // the keep-first `resolution_contexts` table.
    const builder = new ProjectionBuilder(rootA);
    const rows = [...contributionA.contexts, ...contributionB.contexts];

    const recorded = rows.map((row) => builder.addContext(row));

    expect(recorded.every(Boolean)).toBe(true);
    expect(builder.build().resolutionContexts).toHaveLength(rows.length);
  });
});
