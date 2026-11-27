/**
 * The store double keeps the blob and row-set writer contracts, the ones the SQLite store keeps:
 * a suite driving the driver through {@link FakeFactStore} then proves the rule the shipped writer
 * implements, not a rule of the double's own.
 */

import { describe, expect, it } from 'vitest';

import {
  BLOB_WRITER_CONTRACT,
  ROW_SET_WRITER_CONTRACT,
  type BlobWriterContractFactory,
  type RowSetWriterContractFactory,
} from '../src/testing.js';

import { FakeFactStore, WIDE_STORE_BUDGETS } from './fake-fact-store.js';

const openFake: BlobWriterContractFactory = ({ blobTierBudgetBytes }) => {
  const store = new FakeFactStore({ ...WIDE_STORE_BUDGETS, blobTierBudgetBytes });
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

const openFakeForRowSets: RowSetWriterContractFactory = ({ rowSetTierBudgetBytes }) => {
  const store = new FakeFactStore({ ...WIDE_STORE_BUDGETS, rowSetTierBudgetBytes });
  return Promise.resolve({
    store,
    evict: (id) => {
      store.forgetRowSet(id);
      return Promise.resolve();
    },
    ledgerBytes: () => Promise.resolve(store.rowSetLedgerBytes()),
    storedBytes: () => Promise.resolve(store.rowSetStoredBytes()),
  });
};

describe('the store double keeps the blob writer contract', () => {
  for (const contractCase of BLOB_WRITER_CONTRACT) {
    it(contractCase.name, async () => {
      await expect(contractCase.run(openFake), contractCase.mutant).resolves.toBeUndefined();
    });
  }

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses a budget of %s, as the real store does', (budget) => {
    expect(() => new FakeFactStore({ ...WIDE_STORE_BUDGETS, blobTierBudgetBytes: budget })).toThrow(RangeError);
    expect(() => new FakeFactStore({ ...WIDE_STORE_BUDGETS, rowSetTierBudgetBytes: budget })).toThrow(RangeError);
  });
});

describe('the store double keeps the row-set writer contract', () => {
  for (const contractCase of ROW_SET_WRITER_CONTRACT) {
    it(contractCase.name, async () => {
      await expect(contractCase.run(openFakeForRowSets), contractCase.mutant).resolves.toBeUndefined();
    });
  }
});
