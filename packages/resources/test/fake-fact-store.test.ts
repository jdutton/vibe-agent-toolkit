/**
 * The store double keeps the blob writer's contract, the one the SQLite store
 * keeps: a suite driving the driver through {@link FakeFactStore} then proves the
 * rule the shipped writer implements, not a rule of the double's own.
 */

import { describe, expect, it } from 'vitest';

import { BLOB_WRITER_CONTRACT, type BlobWriterContractFactory } from '../src/testing.js';

import { FakeFactStore } from './fake-fact-store.js';

const openFake: BlobWriterContractFactory = ({ blobTierBudgetBytes }) => {
  const store = new FakeFactStore(blobTierBudgetBytes);
  return Promise.resolve({
    store,
    evict: (contentKey) => {
      store.forgetBlobFacts(contentKey);
      return Promise.resolve();
    },
    ledgerBytes: () => Promise.resolve(store.ledgerBytes()),
    storedBytes: () => Promise.resolve(store.storedBytes()),
  });
};

describe('the store double keeps the blob writer contract', () => {
  for (const contractCase of BLOB_WRITER_CONTRACT) {
    it(contractCase.name, async () => {
      await expect(contractCase.run(openFake), contractCase.mutant).resolves.toBeUndefined();
    });
  }

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses a budget of %s, as the real store does', (budget) => {
    expect(() => new FakeFactStore(budget)).toThrow(RangeError);
  });
});
