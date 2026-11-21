import { promises as fs } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';


import { safePath } from '@vibe-agent-toolkit/utils';
import { setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils/testing';
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';

import { CONTENT_KEY_PATTERN, computeContentKey } from '../src/content-key.js';
import { ResourceRegistry } from '../src/resource-registry.js';

import { createTwoFilesWithSameContent } from './test-helpers.js';

/**
 * Per-call logs for the two syscalls `addResource` is allowed exactly one of.
 *
 * PATHS, not counts: the invariant is one read and one stat **of the subject
 * document**, and `addResource` legitimately touches other files — the parse
 * cache reads its own entry (`<tmpdir>/.vat-cache/parse/…`) on every lookup.
 * A bare tally cannot tell that apart from the defect this test exists to catch
 * (a second whole-file read of the document itself), so the assertion filters
 * by path and a cache lookup is correctly invisible to it.
 *
 * `vi.spyOn` cannot be used here: an ESM module namespace is not configurable,
 * and every producer call site (`content-key.ts`, `link-parser.ts`,
 * `html-link-parser.ts`) imports `readFile`/`stat` as *named* bindings, which a
 * spy on the default export object would never reach. Replacing the module is
 * the only interception that covers all of them.
 */
const fsCalls = vi.hoisted(() => ({ readFile: [] as string[], open: [] as string[], stat: [] as string[] }));

/**
 * A `PathLike` argument as a path string.
 *
 * Only `string` and `Buffer` are recognised; a `URL` or a file descriptor comes
 * back as `''` and can therefore never match the subject. That is sound here
 * because every call site under test passes a plain path string — this is a
 * function declaration so the hoisted `vi.mock` factory can reach it.
 */
function pathOf(target: unknown): string {
  if (typeof target === 'string') return target;
  return Buffer.isBuffer(target) ? target.toString('utf-8') : '';
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const counted = {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      fsCalls.readFile.push(pathOf(args[0]));
      return actual.readFile(...args);
    },
    // A read can also go open → `FileHandle.readFile`, which no module-level
    // `readFile` mock sees: `readDecodableBytes` (utils) reads that way so its
    // size check is an `fstat` of the very handle it then reads. An open of the
    // subject is therefore counted as a read of it.
    open: (...args: Parameters<typeof actual.open>) => {
      fsCalls.open.push(pathOf(args[0]));
      return actual.open(...args);
    },
    stat: (...args: Parameters<typeof actual.stat>) => {
      fsCalls.stat.push(pathOf(args[0]));
      return actual.stat(...args);
    },
  };
  // Both shapes, because both are imported in this package: named bindings and
  // `import fs from 'node:fs/promises'` / `await import('node:fs/promises')`.
  return { ...counted, default: counted };
});

describe('ResourceRegistry with content key', () => {
  const suite = setupAsyncTempDirSuite('parser-content-key');
  let tempDir: string;
  let registry: ResourceRegistry;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
    registry = new ResourceRegistry();
  });

  it('records the content key of the bytes it read when adding a resource', async () => {
    const testFile = safePath.join(tempDir, 'test.md');
    const content = '# Test\n\nContent here.';
    await fs.writeFile(testFile, content, 'utf-8');

    const metadata = await registry.addResource(testFile);

    expect(metadata.contentKey).toMatch(CONTENT_KEY_PATTERN);
    expect(metadata.contentKey).toBe(computeContentKey(Buffer.from(content, 'utf-8'), 'markdown'));
  });

  it('should return same content key for same content', async () => {
    const { file1, file2 } = await createTwoFilesWithSameContent(
      tempDir, '# Same Content\n\nIdentical text.',
    );

    const metadata1 = await registry.addResource(file1);
    const metadata2 = await registry.addResource(file2);

    expect(metadata1.contentKey).toBe(metadata2.contentKey);
  });

  it('should return different content keys for different content', async () => {
    const file1 = safePath.join(tempDir, 'file1.md');
    const file2 = safePath.join(tempDir, 'file2.md');
    await fs.writeFile(file1, '# Content A', 'utf-8');
    await fs.writeFile(file2, '# Content B', 'utf-8');

    const metadata1 = await registry.addResource(file1);
    const metadata2 = await registry.addResource(file2);

    expect(metadata1.contentKey).not.toBe(metadata2.contentKey);
  });

  it('reads and stats each file exactly once', async () => {
    const testFile = safePath.join(tempDir, 'read-once.md');
    await fs.writeFile(testFile, '# Once\n\n[a](./a.md)\n', 'utf-8');

    // `node:fs`'s `promises` object is a DIFFERENT object from the mocked
    // `node:fs/promises` module above, so the module mock cannot see calls made
    // through it — and that is exactly the door a path-taking re-hash of the
    // file once used for a second whole-file read. Count both routes, so an
    // extra read is caught whichever one it comes through.
    const legacyReadFile = vi.spyOn(fs, 'readFile');
    fsCalls.readFile.length = 0;
    fsCalls.open.length = 0;
    fsCalls.stat.length = 0;

    await registry.addResource(testFile);

    const legacyPaths = legacyReadFile.mock.calls.map((call) => pathOf(call[0]));
    legacyReadFile.mockRestore();

    // Scoped to the subject: reads of the parse cache's own entry file are not
    // reads of this document. See the note on `fsCalls`.
    const subject = safePath.resolve(testFile);
    const isSubject = (candidate: string): boolean => safePath.resolve(candidate) === subject;
    const totalReads = [...fsCalls.readFile, ...fsCalls.open, ...legacyPaths].filter(isSubject).length;
    const totalStats = fsCalls.stat.filter(isSubject).length;

    // One assertion, not two, so a failure reports BOTH numbers — the read and
    // the stat regressed together historically and should be read together.
    expect({ reads: totalReads, stats: totalStats }).toEqual({ reads: 1, stats: 1 });
  });

  it('takes sizeBytes from stat() and the content key from the raw bytes', async () => {
    // Every other fixture in this suite is ASCII, where `stat().size` and
    // `Buffer.byteLength(decoded)` are the same number — so none of them can
    // tell the two apart. A lone 0xFF is invalid UTF-8 and decodes to U+FFFD,
    // which re-encodes to THREE bytes, forcing them to disagree. Without this
    // fixture, swapping `stat().size` for a count derived from the decoded
    // string leaves the whole markdown + HTML suite green, and that swap is a
    // real defect: `sizeBytes` reaches packaged-output accounting via
    // content-transform.ts and adopter-visible rule variables.
    const testFile = safePath.join(tempDir, 'malformed.md');
    await fs.writeFile(
      testFile,
      Uint8Array.from([...Buffer.from('# Bad\n'), 0xff, ...Buffer.from('\n')]),
    );

    const [decoded, stats] = await Promise.all([
      fs.readFile(testFile, 'utf-8'),
      fs.stat(testFile),
    ]);

    // Guard the guard: if these ever stop differing the fixture is inert and
    // every assertion below becomes vacuous.
    expect(stats.size).toBe(8);
    expect(Buffer.byteLength(decoded)).toBe(10);

    const metadata = await registry.addResource(testFile);

    // Invariant 1: sizeBytes is stat-sourced, never derived from the decode.
    expect(metadata.sizeBytes).toBe(stats.size);
    expect(metadata.sizeBytes).not.toBe(Buffer.byteLength(decoded));

    // Invariant 2: the content key hashes the RAW bytes under the parse route
    // (content-key.ts), never the decoded string, which re-encodes here to
    // different bytes.
    const raw = Uint8Array.from([...Buffer.from('# Bad\n'), 0xff, ...Buffer.from('\n')]);
    expect(metadata.contentKey).toBe(computeContentKey(raw, 'markdown'));
    expect(metadata.contentKey).not.toBe(computeContentKey(Buffer.from(decoded, 'utf-8'), 'markdown'));
  });
});
