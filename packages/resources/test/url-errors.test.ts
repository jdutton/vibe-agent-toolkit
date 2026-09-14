import { describe, expect, it } from 'vitest';

import { isInvalidUrlError } from '../src/url-errors.js';

/** What `new URL` actually throws for a string it refuses. */
function urlParserRefusal(): unknown {
  try {
    new URL('not a url');
  } catch (error) {
    return error;
  }
  throw new Error('the fixture is not a refused URL');
}

describe('isInvalidUrlError', () => {
  it("names the URL parser's own refusal", () => {
    expect(isInvalidUrlError(urlParserRefusal())).toBe(true);
  });

  it('does not name a TypeError from anywhere else — a bug is not a malformed URL', () => {
    expect(isInvalidUrlError(new TypeError('Cannot read properties of undefined'))).toBe(false);
  });

  it('does not name an errno, a plain Error, or a non-error', () => {
    expect(isInvalidUrlError(Object.assign(new Error('EACCES'), { code: 'EACCES' }))).toBe(false);
    expect(isInvalidUrlError(new Error('ERR_INVALID_URL'))).toBe(false);
    expect(isInvalidUrlError({ code: 'ERR_INVALID_URL' })).toBe(false);
    expect(isInvalidUrlError(undefined)).toBe(false);
  });
});
