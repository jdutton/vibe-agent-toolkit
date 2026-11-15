/**
 * The off-chain record of faults raised while a failure was being handled: read
 * back along the thrown value's cause chain (a wrapper must not hide what was left
 * behind), never by mutating anything, and never silent for a thrown non-object.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { recordSuppressedFault, suppressedFaultsOf } from '../../src/errors/suppressed-faults.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('suppressedFaultsOf', () => {
  it('collects the records of the thrown value and of every error on its cause chain, outermost first', () => {
    const original = new Error('work failed');
    const wrapper = new Error('could not be undone', { cause: original });
    const outer = new Error('verb boundary', { cause: wrapper });
    recordSuppressedFault(original, 'staged left');
    recordSuppressedFault(outer, 'temp left');

    expect(suppressedFaultsOf(outer)).toEqual(['temp left', 'staged left']);
    expect(suppressedFaultsOf(original)).toEqual(['staged left']);
  });

  it('terminates on a cause cycle, reading each error once', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    Object.defineProperty(a, 'cause', { value: b });
    recordSuppressedFault(a, 'left by a');

    expect(suppressedFaultsOf(b)).toEqual(['left by a']);
  });

  it('answers nothing for an error with nothing recorded, and for a non-object', () => {
    expect(suppressedFaultsOf(new Error('clean', { cause: new Error('also clean') }))).toEqual([]);
    expect(suppressedFaultsOf('a string')).toEqual([]);
    expect(suppressedFaultsOf(null)).toEqual([]);
  });
});

describe('recordSuppressedFault on a thrown value that cannot carry a record', () => {
  it.each([['a string', 'boom'], ['null', null]] as const)('emits a process warning for %s, never silent', (_name, thrown) => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    recordSuppressedFault(thrown, new Error('could not remove /tmp/x'));
    expect(warn).toHaveBeenCalledWith('could not remove /tmp/x', 'VatSuppressedFault');
  });
});
