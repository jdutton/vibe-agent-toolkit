import { describe, expect, it } from 'vitest';

import { ContributorRegistry } from '../src/projection/contributor.js';
import type { ExtentContribution, ExtentContributor } from '../src/projection/contributor.js';
import { extentDigest } from '../src/projection/digest.js';
import { ClosureNonConvergenceError, populate } from '../src/projection/merge.js';

/**
 * A root that is never touched on disk.
 *
 * Deliberately not under `/tmp`: `sonarjs/publicly-writable-directories` rejects
 * the literal whatever the test does with it, and nothing here needs the path to
 * exist — identity minting falls back to the unresolved path.
 */
const ROOT = '/vat-corpus/merge-fixture';
const CTX = 'ctx-test';
const KIND = 'test';
const BASE: ExtentContributor['stratum'] = 'base';
const CLOSURE: ExtentContributor['stratum'] = 'closure';
const BASE_ID = 'test:base';
const CLOSURE_ID = 'test:closure';
const GROWING_ID = 'test:growing';
const OSCILLATOR = 'test:oscillator';
const MEMBER_A = 'res-a';
const MEMBER_B = 'res-b';

function contribution(memberIds: readonly string[]): ExtentContribution {
  return {
    contexts: [{ contextId: CTX, species: 'extent', kind: KIND, rootId: 'root-x', extentContextId: null, role: null }],
    resources: [],
    realizations: [],
    tags: [],
    conditions: [],
    memberships: memberIds.map((resourceId) => ({ resourceId, extentId: CTX })),
  };
}

/** Counts its own invocations, so "ran once" is observable rather than assumed. */
function countingContributor(id: string, stratum: ExtentContributor['stratum']): ExtentContributor & { calls: number } {
  // Annotated rather than inferred: an object literal whose own method reads the
  // binding it initializes is circular for inference (TS7022).
  const self: ExtentContributor & { calls: number } = {
    id,
    kind: KIND,
    stratum,
    calls: 0,
    contribute: async (): Promise<ExtentContribution> => {
      self.calls++;
      return contribution(['res-stable']);
    },
  };
  return self;
}

/**
 * A closure contributor whose extent grows for one round and then holds.
 *
 * The driver must notice the hold, which costs one confirming call — so a
 * correct driver invokes it exactly three times.
 */
function growingContributor(): ExtentContributor & { calls: number } {
  const self: ExtentContributor & { calls: number } = {
    id: GROWING_ID,
    kind: KIND,
    stratum: CLOSURE,
    calls: 0,
    contribute: async (): Promise<ExtentContribution> => {
      self.calls++;
      return contribution(self.calls === 1 ? [MEMBER_A] : [MEMBER_A, MEMBER_B]);
    },
  };
  return self;
}

/** The extent {@link growingContributor} settles on. */
const SETTLED = [MEMBER_A, MEMBER_B];

/** A closure contributor that alternates between two extents and never settles. */
function oscillator(): ExtentContributor {
  let flip = false;
  return {
    id: OSCILLATOR,
    kind: KIND,
    stratum: CLOSURE,
    contribute: async (): Promise<ExtentContribution> => {
      flip = !flip;
      return contribution(flip ? [MEMBER_A] : [MEMBER_B]);
    },
  };
}

function registryWith(...contributors: readonly ExtentContributor[]): ContributorRegistry {
  const registry = new ContributorRegistry();
  for (const contributor of contributors) {
    registry.register(contributor);
  }
  return registry;
}

describe('populate', () => {
  it('runs a base contributor exactly once', async () => {
    const contributor = countingContributor(BASE_ID, BASE);

    await populate({ root: ROOT, registry: registryWith(contributor) });
    expect(contributor.calls).toBe(1);
  });

  it('runs a closure contributor until its digest stops moving, then once more to prove it', async () => {
    const contributor = growingContributor();

    await populate({ root: ROOT, registry: registryWith(contributor) });
    expect(contributor.calls).toBe(3);
  });

  it('re-merging an identical contribution adds nothing — the fixpoint needs idempotence', async () => {
    // Three passes over a contributor emitting two memberships must leave two
    // rows, not six. Without the builder's de-duplication the digest would still
    // settle but the tables would not.
    const projection = await populate({ root: ROOT, registry: registryWith(growingContributor()) });
    expect(projection.resourceExtents).toHaveLength(2);
    expect(projection.resolutionContexts).toHaveLength(1);
  });

  it('writes one provenance row per contributor, carrying the required digest', async () => {
    const registry = registryWith(countingContributor(BASE_ID, BASE));

    const projection = await populate({ root: ROOT, registry });
    expect(projection.zoneProvenance).toHaveLength(1);
    expect(projection.zoneProvenance[0]?.contributorId).toBe(BASE_ID);
    expect(projection.zoneProvenance[0]?.extentDigest).toMatch(/^[\da-f]{16,}$/u);
  });

  it('records the FINAL digest of a closure contributor, never iteration one', async () => {
    // The provenance table replaces on conflict for exactly this reason: a
    // kept-first digest would describe the extent the contributor started from.
    const projection = await populate({ root: ROOT, registry: registryWith(growingContributor()) });
    expect(projection.zoneProvenance).toHaveLength(1);
    expect(projection.zoneProvenance[0]?.extentDigest).toBe(extentDigest(contribution(SETTLED)));
    expect(projection.zoneProvenance[0]?.extentDigest)
      .not.toBe(extentDigest(contribution([MEMBER_A])));
  });

  it('records the parameter set it passed, so provenance cannot under-describe the extent', async () => {
    // §7.4: "the parameters this contributor ran under, verbatim". The value the
    // contributor SAW and the value the row CARRIES are asserted to be the same
    // object graph, which is the whole point of passing rather than declaring it.
    let seen: unknown;
    const declaration = { closureFrom: [MEMBER_A], follow: ['link'], maxDepth: 3 };
    const registry = registryWith({
      id: BASE_ID,
      kind: KIND,
      stratum: BASE,
      contribute: async (_base, parameters) => {
        seen = parameters;
        return contribution([]);
      },
    });

    const projection = await populate({
      root: ROOT,
      registry,
      parameters: { [BASE_ID]: declaration },
    });
    expect(seen).toEqual(declaration);
    expect(projection.zoneProvenance[0]?.parameterSet).toEqual(declaration);
    expect(projection.zoneProvenance[0]?.parameterSet).toBe(seen);
  });

  it('records null for a contributor given no parameters', async () => {
    const registry = registryWith(countingContributor(BASE_ID, BASE));

    const projection = await populate({ root: ROOT, registry });
    expect(projection.zoneProvenance[0]?.parameterSet).toBeNull();
  });

  it('THROWS on non-convergence rather than returning a partial extent', async () => {
    const registry = registryWith(oscillator());

    await expect(populate({ root: ROOT, registry, maxIterations: 4 }))
      .rejects.toThrow(ClosureNonConvergenceError);
  });

  it('names the contributors still moving, so the failure is diagnosable', async () => {
    const registry = registryWith(oscillator());

    await expect(populate({ root: ROOT, registry, maxIterations: 4 }))
      .rejects.toThrow(new RegExp(OSCILLATOR, 'u'));
  });

  it('carries the pass count and the moving ids as fields, not only in the message', async () => {
    const registry = registryWith(oscillator());

    const error = await populate({ root: ROOT, registry, maxIterations: 4 }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ClosureNonConvergenceError);
    expect((error as ClosureNonConvergenceError).iterations).toBe(4);
    expect((error as ClosureNonConvergenceError).contributorIds).toEqual([OSCILLATOR]);
  });

  it('runs base contributors before closure ones', async () => {
    const order: string[] = [];
    const registry = registryWith(
      {
        id: CLOSURE_ID,
        kind: KIND,
        stratum: CLOSURE,
        contribute: async () => {
          order.push(CLOSURE);
          return contribution([]);
        },
      },
      {
        id: BASE_ID,
        kind: KIND,
        stratum: BASE,
        contribute: async () => {
          order.push(BASE);
          return contribution([]);
        },
      },
    );

    await populate({ root: ROOT, registry });
    expect(order[0]).toBe(BASE);
  });

  it('a closure contributor sees what the base stratum contributed', async () => {
    // The fixpoint is only meaningful if `base()` is live. A snapshot taken per
    // iteration would leave this at zero.
    let observedMembers = -1;
    const registry = registryWith(
      countingContributor(BASE_ID, BASE),
      {
        id: CLOSURE_ID,
        kind: KIND,
        stratum: CLOSURE,
        contribute: async (base) => {
          observedMembers = base.resourceExtents.length;
          return contribution([]);
        },
      },
    );

    await populate({ root: ROOT, registry });
    expect(observedMembers).toBe(1);
  });

  it('is ordinary and fast with no closure contributors at all', async () => {
    const registry = registryWith(countingContributor(BASE_ID, BASE));

    await expect(populate({ root: ROOT, registry, maxIterations: 1 })).resolves.toBeDefined();
  });

  it('propagates a failure from a base contributor instead of reporting an empty extent', async () => {
    // `GitExtentContributor` throws outside a repository by design; swallowing it
    // would produce a projection with no git extent and no record of the attempt.
    const registry = registryWith({
      id: BASE_ID,
      kind: KIND,
      stratum: BASE,
      contribute: async () => {
        throw new Error('git did not answer');
      },
    });

    await expect(populate({ root: ROOT, registry })).rejects.toThrow(/git did not answer/u);
  });

  it('records the corpus root no contribution can carry', async () => {
    const registry = registryWith(countingContributor(BASE_ID, BASE));

    const projection = await populate({ root: ROOT, registry });
    expect(projection.roots).toHaveLength(1);
    // Matched rather than compared: `safePath.resolve` drives it off the cwd, so
    // a bare POSIX literal gains a drive letter on Windows.
    expect(projection.roots[0]?.path).toMatch(/merge-fixture$/u);
    expect(projection.roots[0]?.id).toMatch(/^root-\w+$/u);
  });
});
