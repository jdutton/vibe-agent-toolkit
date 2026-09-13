/**
 * `VatError` is the one base every VAT-thrown error class extends, and `code`
 * is the one thing a catch block may dispatch on. Forty-eight classes used to
 * extend `Error` directly with no shared identity, so the only way to tell
 * "the path escaped its root" from "boom" was to read the prose — and three
 * packages did, with `error.message.startsWith('safePath.joinUnderRoot:')`.
 * A message is for a human; a code is for a program. These tests pin that
 * the code survives everything a message does not: subclassing, `cause`
 * wrapping, and the `src`/`dist` realm boundary that defeats `instanceof`.
 */

import { describe, expect, it } from 'vitest';

import { isVatError, PathEscapesRootError, prefixMessageOnce, safePath, VatError } from '../../src/index.js';

class DemoError extends VatError {
  constructor(message: string, options?: ErrorOptions) {
    super('DEMO', message, options);
  }
}

describe('VatError', () => {
  it('carries a code and takes its name from the subclass', () => {
    const error = new DemoError('boom');
    expect(error.code).toBe('DEMO');
    expect(error.name).toBe('DemoError');
    expect(error.message).toBe('boom');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(VatError);
  });

  it('forwards `cause` like a native Error', () => {
    const cause = new Error('root');
    expect(new DemoError('boom', { cause }).cause).toBe(cause);
  });

  it('renders the code in its stack line so a bare crash still names it', () => {
    expect(String(new DemoError('boom'))).toBe('DemoError [DEMO]: boom');
  });
});

describe('isVatError', () => {
  it('answers by brand, not by prototype — a dist-realm copy still matches', () => {
    // Simulates the object a `dist` copy of the class produces: same shape and
    // brand, a prototype chain this module has never seen.
    const foreignRealm = Object.assign(new Error('boom'), {
      code: 'DEMO',
      [Symbol.for('vat.error')]: true,
    });
    expect(foreignRealm).not.toBeInstanceOf(VatError);
    expect(isVatError(foreignRealm)).toBe(true);
    expect(isVatError(foreignRealm, 'DEMO')).toBe(true);
  });

  it('narrows on the code when one is asked for', () => {
    const error = new DemoError('boom');
    expect(isVatError(error, 'DEMO')).toBe(true);
    expect(isVatError(error, 'OTHER')).toBe(false);
  });

  it('does not mistake a foreign `code` for a VAT one', () => {
    // `node:fs` errors and HTTP clients both carry `code`; none carry the brand.
    expect(isVatError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(false);
    expect(isVatError(Object.assign(new Error('x'), { code: 'DEMO' }), 'DEMO')).toBe(false);
    expect(isVatError(new Error('x'))).toBe(false);
    expect(isVatError(undefined)).toBe(false);
    expect(isVatError('DEMO')).toBe(false);
  });
});

describe('PathEscapesRootError', () => {
  it('is what joinUnderRoot throws, and is recognised by code rather than by prose', () => {
    let caught: unknown;
    try {
      safePath.joinUnderRoot('/root', '../escape');
    } catch (error) {
      caught = error;
    }
    expect(isVatError(caught, PathEscapesRootError.code)).toBe(true);
    expect(caught).toBeInstanceOf(PathEscapesRootError);
    expect((caught as Error).message).toContain('escapes root');
  });
});

describe('prefixMessageOnce', () => {
  it('prefixes in place, keeping the class, and only once per error object', () => {
    const error = new DemoError('boom');
    prefixMessageOnce(error, '[arm] ');
    prefixMessageOnce(error, '[arm] ');
    prefixMessageOnce(error, '[other] ');
    expect(error.message).toBe('[arm] boom');
    expect(error).toBeInstanceOf(DemoError);
  });

  it('leaves a non-Error untouched', () => {
    expect(() => prefixMessageOnce('boom', 'x')).not.toThrow();
    expect(() => prefixMessageOnce(undefined, 'x')).not.toThrow();
  });
});
