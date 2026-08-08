import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';


import { setupAsyncTempDirSuite, safePath } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';

import { ResourceRegistry } from '../src/resource-registry.js';

import { createTwoFilesWithSameContent } from './test-helpers.js';

/**
 * Per-call tallies for the two syscalls `addResource` is allowed exactly one of.
 *
 * `vi.spyOn` cannot be used here: an ESM module namespace is not configurable,
 * and every producer call site (`content-key.ts`, `link-parser.ts`,
 * `html-link-parser.ts`) imports `readFile`/`stat` as *named* bindings, which a
 * spy on the default export object would never reach. Replacing the module is
 * the only interception that covers all of them.
 */
const fsCounters = vi.hoisted(() => ({ readFile: 0, stat: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const counted = {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      fsCounters.readFile += 1;
      return actual.readFile(...args);
    },
    stat: (...args: Parameters<typeof actual.stat>) => {
      fsCounters.stat += 1;
      return actual.stat(...args);
    },
  };
  // Both shapes, because both are imported in this package: named bindings and
  // `import fs from 'node:fs/promises'` / `await import('node:fs/promises')`.
  return { ...counted, default: counted };
});

describe('ResourceRegistry with checksum', () => {
  const suite = setupAsyncTempDirSuite('parser-checksum');
  let tempDir: string;
  let registry: ResourceRegistry;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
    // Create fresh registry for checksum validation
    registry = new ResourceRegistry();
  });

  it('should calculate checksum when adding resource', async () => {
    const testFile = safePath.join(tempDir, 'test.md');
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.writeFile(testFile, '# Test\n\nContent here.', 'utf-8');

    const metadata = await registry.addResource(testFile);

    expect(metadata.checksum).toBeDefined();
    expect(metadata.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('should return same checksum for same content', async () => {
    const { file1, file2 } = await createTwoFilesWithSameContent(
      tempDir, '# Same Content\n\nIdentical text.',
    );

    const metadata1 = await registry.addResource(file1);
    const metadata2 = await registry.addResource(file2);

    expect(metadata1.checksum).toBe(metadata2.checksum);
  });

  it('should return different checksums for different content', async () => {
    const file1 = safePath.join(tempDir, 'file1.md');
    const file2 = safePath.join(tempDir, 'file2.md');
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.writeFile(file1, '# Content A', 'utf-8');
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.writeFile(file2, '# Content B', 'utf-8');

    const metadata1 = await registry.addResource(file1);
    const metadata2 = await registry.addResource(file2);

    expect(metadata1.checksum).not.toBe(metadata2.checksum);
  });

  it('reads and stats each file exactly once', async () => {
    const testFile = safePath.join(tempDir, 'read-once.md');
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.writeFile(testFile, '# Once\n\n[a](./a.md)\n', 'utf-8');

    // `node:fs`'s `promises` object is a DIFFERENT object from the mocked
    // `node:fs/promises` module above, so the module mock cannot see calls made
    // through it — and that is exactly the door `checksum.ts`'s path-taking
    // `calculateChecksum` used for its second whole-file read. Count both
    // routes, so an extra read is caught whichever one it comes through.
    const legacyReadFile = vi.spyOn(fs, 'readFile');
    fsCounters.readFile = 0;
    fsCounters.stat = 0;

    await registry.addResource(testFile);

    const totalReads = fsCounters.readFile + legacyReadFile.mock.calls.length;
    const totalStats = fsCounters.stat;
    legacyReadFile.mockRestore();

    // One assertion, not two, so a failure reports BOTH numbers — the read and
    // the stat regressed together historically and should be read together.
    expect({ reads: totalReads, stats: totalStats }).toEqual({ reads: 1, stats: 1 });
  });

  it('takes sizeBytes from stat() and the checksum from the decoded string', async () => {
    // Every other fixture in this suite is ASCII, where `stat().size` and
    // `Buffer.byteLength(decoded)` are the same number — so none of them can
    // tell the two apart. A lone 0xFF is invalid UTF-8 and decodes to U+FFFD,
    // which re-encodes to THREE bytes, forcing them to disagree. Without this
    // fixture, swapping `stat().size` for a count derived from the decoded
    // string leaves the whole markdown + HTML suite green, and that swap is a
    // real defect: `sizeBytes` reaches packaged-output accounting via
    // content-transform.ts and adopter-visible rule variables.
    const testFile = safePath.join(tempDir, 'malformed.md');
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.writeFile(
      testFile,
      Uint8Array.from([...Buffer.from('# Bad\n'), 0xff, ...Buffer.from('\n')]),
    );

    const [decoded, stats] = await Promise.all([
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      fs.readFile(testFile, 'utf-8'),
      // eslint-disable-next-line security/detect-non-literal-fs-filename
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

    // Invariant 2: the checksum hashes the DECODED string — a different
    // keyspace from the content key, which hashes the raw bytes on purpose.
    expect(metadata.checksum).toBe(createHash('sha256').update(decoded, 'utf-8').digest('hex'));
    expect(metadata.checksum).not.toBe(
      createHash('sha256')
        .update(Uint8Array.from([...Buffer.from('# Bad\n'), 0xff, ...Buffer.from('\n')]))
        .digest('hex'),
    );
  });
});
