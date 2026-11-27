/**
 * What the blob-tier and row-set-tier writer contracts share: the cases both tiers run, named once
 * so the two suites cannot drift apart on what a case claims, and the fixture minting they both do.
 */

/**
 * Three fixture values minted from three seeds, as a tuple the writer contracts destructure
 * without an `undefined` guard: mapping an array of seeds types each element as possibly absent.
 *
 * @param mint - Mints one value from its seed
 * @param seeds - The three seeds, in the order the values come back
 * @returns The minted values, in seed order
 */
export function mintThree<T>(mint: (seed: string) => T, seeds: readonly [string, string, string]): [T, T, T] {
  return [mint(seeds[0]), mint(seeds[1]), mint(seeds[2])];
}

/** The seeds of the presence case both writer contracts run: a kept, an evicted and an unwritten one. */
export const PRESENCE_SEEDS = ['present-kept', 'present-evicted', 'present-unwritten'] as const;

/** The seeds of the mixed-writes ledger case both writer contracts run. */
export const MIXED_SEEDS = ['mixed-a', 'mixed-b', 'mixed-c'] as const;

/** The presence case both writer contracts run, each on its own tier's ids. */
export const PRESENCE_CASE = {
  name: 'presence is read in the rows\' transaction, from the ledger and not from the rows',
  mutant: 'derive present from the returned rows',
} as const;
