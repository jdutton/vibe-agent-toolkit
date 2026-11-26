import { describe, expect, it } from 'vitest';

import { readOnlyDatabaseUri } from '../src/sqlite-uri.js';

describe('readOnlyDatabaseUri', () => {
  it('puts a POSIX path after an empty authority', () => {
    expect(readOnlyDatabaseUri('/tmp/vat-cache/store.db')).toBe('file:///tmp/vat-cache/store.db?mode=ro');
  });

  it('puts a Windows drive path after an empty authority, forward-slashed', () => {
    expect(readOnlyDatabaseUri(String.raw`C:\Users\a\cache\store.db`)).toBe('file:///C:/Users/a/cache/store.db?mode=ro');
  });

  it('keeps a UNC path\'s server inside the path, never in the authority SQLite refuses', () => {
    const uri = readOnlyDatabaseUri(String.raw`\\server\share\cache\store.db`);
    expect(uri).toBe('file:////server/share/cache/store.db?mode=ro');
    // `pathToFileURL` gives `file://server/share/...`: an authority of `server`.
    expect(new URL(uri).host).toBe('');
  });

  it('escapes the three characters that would end the path', () => {
    expect(readOnlyDatabaseUri('/tmp/a%b?c#d/store.db')).toBe('file:///tmp/a%25b%3Fc%23d/store.db?mode=ro');
  });

  it('percent-encodes the rest of the path, which SQLite decodes', () => {
    expect(readOnlyDatabaseUri('/tmp/a b/store.db')).toBe('file:///tmp/a%20b/store.db?mode=ro');
  });

  it('refuses a relative path', () => {
    expect(() => readOnlyDatabaseUri('cache/store.db')).toThrow(/not an absolute path/);
  });
});
