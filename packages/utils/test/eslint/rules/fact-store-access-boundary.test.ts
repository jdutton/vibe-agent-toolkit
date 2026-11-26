/**
 * `fact-store-access-boundary` — every way a module can reach the store's stored-fact members is
 * an access, a reference handed on included. The rule has no scope of its own: the config that
 * enables it says which files may reach the port. The VALID cases pin the forwarding wrapper and
 * what only looks like an access.
 */

import { describe, it } from 'vitest';

import { RULE_TESTER_CASES, type RuleCases, expectRulePasses } from '../rule-tester.js';

const RULE = 'fact-store-access-boundary';
const FILE = '/repo/packages/resources/src/projection/merge.ts';
const error = (name: string): Array<{ messageId: string; data: { name: string } }> => [{ messageId: 'portAccess', data: { name } }];

const CASES: RuleCases = {
  valid: [
    { code: 'export const rows = reads.blobs(keys, request);', filename: FILE },
    { code: 'export const rows = run.stored.of(store).extent(key, request);', filename: FILE },
    // A forwarding wrapper: the access is the value of a property of the same name.
    { code: 'export const wrapped = { readBlobFacts: (keys, request) => store.readBlobFacts(keys, request) };', filename: FILE },
    { code: 'export const wrapped = { writeExtent: (key, rows) => store.writeExtent(key, rows).catch(coded) };', filename: FILE },
    { code: 'export const wrapped = { readExtent(key, request) { return store.readExtent(key, request); } };', filename: FILE },
    { code: 'export class Wrapped { readBlobFacts(keys, request) { return this.inner.readBlobFacts(keys, request); } }', filename: FILE },
    // A property DEFINING the member is not an access of it.
    { code: 'export const store = { readBlobFacts: () => Promise.resolve({}) };', filename: FILE },
    { code: "export const name = 'readBlobFacts';", filename: FILE },
    { code: 'export const rows = store[name](keys);', filename: FILE },
  ],
  invalid: [
    { code: 'export const rows = await cache.store.readBlobFacts(keys, request);', filename: FILE, errors: error('readBlobFacts') },
    { code: 'export const rows = await store.readExtent(key, request);', filename: FILE, errors: error('readExtent') },
    { code: 'await store.writeBlobFacts(write);', filename: FILE, errors: error('writeBlobFacts') },
    { code: 'await store.writeExtent(key, rows);', filename: FILE, errors: error('writeExtent') },
    { code: "export const rows = await store['readBlobFacts'](keys, request);", filename: FILE, errors: error('readBlobFacts') },
    { code: 'export const read = store.readBlobFacts.bind(store);', filename: FILE, errors: error('readBlobFacts') },
    { code: 'export const { readExtent } = store;', filename: FILE, errors: error('readExtent') },
    // A wrapper of ANOTHER name is a second reader.
    { code: 'export const wrapped = { readBlobs: (keys, request) => store.readBlobFacts(keys, request) };', filename: FILE, errors: error('readBlobFacts') },
    // Nested in a function inside the wrapper is no longer the forward itself.
    {
      code: 'export const wrapped = { readExtent: (key, request) => later(() => store.readExtent(key, request)) };',
      filename: FILE,
      errors: error('readExtent'),
    },
  ],
};

describe(RULE, () => {
  it(RULE_TESTER_CASES, () => {
    expectRulePasses(RULE, CASES);
  });
});
