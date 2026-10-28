import * as nodeFs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { crawlDirectorySync } from '../../src/file-crawler.js';
import { normalizedTmpdir, normalizePath, realpathNative, realpathNativeSync, safePath, toForwardSlash } from '../../src/path-utils.js';
import { refuseUnreadableFixture } from '../../src/testing.js';

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

/** Make both native realpaths fail with `code`, for every path. */
function failNative(code: string): void {
  vi.spyOn(nodeFs.realpathSync, 'native').mockImplementation(() => { throw errno(code); });
  vi.spyOn(nodeFs.realpath, 'native').mockImplementation(((_path: unknown, callback: (error: Error) => void) => { callback(errno(code)); }) as never);
}

// A volume that cannot answer a final-path query fails EVERY native realpath (Windows'
// ERROR_INVALID_FUNCTION is EISDIR); the JS walk still answers. Any other error is the
// resolution's own and reaches the caller to classify.
describe('realpathNativeSync / realpathNative', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-realpath-native-'));
    file = safePath.join(dir, 'a.md');
    writeFileSync(file, 'x');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers the native realpath, forward-slashed', async () => {
    const real = toForwardSlash(nodeFs.realpathSync.native(file));
    expect(realpathNativeSync(file)).toBe(real);
    expect(await realpathNative(file)).toBe(real);
  });

  it.each(['EISDIR', 'ENOTSUP', 'EOPNOTSUPP'])('asks the JS realpath again when the native one fails with %s', async (code) => {
    const js = toForwardSlash(nodeFs.realpathSync(file));
    failNative(code);
    expect(realpathNativeSync(file)).toBe(js);
    expect(await realpathNative(file)).toBe(js);
  });

  // normalizePath is a native realpath site too, so it owes the same fallback.
  it('normalizes through the JS realpath when the volume cannot answer a native one', () => {
    const js = nodeFs.realpathSync(file);
    failNative('EISDIR');
    expect(normalizePath(file)).toBe(js);
  });

  it.each(['EACCES', 'UNKNOWN'])('throws the native %s as it was — the caller classifies it', async (code) => {
    failNative(code);
    expect(() => realpathNativeSync(file)).toThrow(expect.objectContaining({ code }));
    await expect(realpathNative(file)).rejects.toMatchObject({ code });
  });

  // ONE fallback rule for every native site: a native "absent" is confirmed by the JS walk (a musl
  // libc without procfs answers ENOENT for a path that exists), exactly as normalizePath always did.
  it('asks the JS realpath to confirm a native ENOENT, answering a path that exists', async () => {
    const js = toForwardSlash(nodeFs.realpathSync(file));
    failNative('ENOENT');
    expect(realpathNativeSync(file)).toBe(js);
    expect(await realpathNative(file)).toBe(js);
    expect(toForwardSlash(normalizePath(file))).toBe(js);
  });

  it('throws ENOENT for a path the JS walk also finds absent', async () => {
    const missing = safePath.join(dir, 'missing.md');
    failNative('ENOENT');
    expect(() => realpathNativeSync(missing)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    await expect(realpathNative(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // The crawler's link-cycle identity check is a native realpath site too.
  it('crawls following links on a volume that cannot answer a native realpath', () => {
    failNative('EISDIR');
    const found = crawlDirectorySync({
      outputs: [], baseDir: dir, include: ['**/*.md'], followSymlinks: true, absolute: false, respectGitignore: false, unreadable: refuseUnreadableFixture(dir),
    });
    expect(found).toEqual(['a.md']);
  });
});
