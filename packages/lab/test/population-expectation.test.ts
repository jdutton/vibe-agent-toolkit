/**
 * What an arm's populating run must leave behind is a function of the arm's
 * own environment, not a fixed property of the command: an arm that turns the
 * projection store off must not be asserted to write one, and an arm that
 * turns VAT's caches off must not be asserted to write a parse shard either.
 */

import { describe, expect, it } from 'vitest';

import { populationExpectation } from '../src/harness/population-expectation.js';

describe('populationExpectation', () => {
  it.for([
    { name: 'nothing set', set: {}, store: true, parseShard: true },
    { name: 'the store selected by name', set: { VAT_PROJECTION_STORE: 'sqlite' }, store: true, parseShard: true },
    { name: 'the store on', set: { VAT_PROJECTION_STORE: '1' }, store: true, parseShard: true },
    { name: 'the store off', set: { VAT_PROJECTION_STORE: 'off' }, store: false, parseShard: true },
    { name: 'the store off as 0', set: { VAT_PROJECTION_STORE: '0' }, store: false, parseShard: true },
    { name: 'the store selector cleared', set: { VAT_PROJECTION_STORE: '' }, store: false, parseShard: true },
    { name: 'the store selector unreadable', set: { VAT_PROJECTION_STORE: 'maybe' }, store: true, parseShard: true },
    { name: 'every cache off', set: { VAT_CACHE: '0' }, store: false, parseShard: false },
    { name: 'every cache off, spelled false', set: { VAT_CACHE: 'false' }, store: false, parseShard: false },
    { name: 'caches on, store on', set: { VAT_CACHE: '1', VAT_PROJECTION_STORE: 'sqlite' }, store: true, parseShard: true },
    { name: 'the cache veto beating a selected store', set: { VAT_CACHE: 'no', VAT_PROJECTION_STORE: 'sqlite' }, store: false, parseShard: false },
  ])('expects store=$store, parseShard=$parseShard with $name', ({ set, store, parseShard }) => {
    expect(populationExpectation({ set, unset: [] }, 'linux')).toEqual({ store, parseShard });
  });

  it('reads a Windows arm\'s names case-insensitively, as the child will see them', () => {
    expect(populationExpectation({ set: { vat_projection_store: 'off' }, unset: [] }, 'win32')).toEqual({
      store: false,
      parseShard: true,
    });
    // POSIX names are case-sensitive: a lower-case name is another variable.
    expect(populationExpectation({ set: { vat_projection_store: 'off' }, unset: [] }, 'linux')).toEqual({
      store: true,
      parseShard: true,
    });
  });
});
