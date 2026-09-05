import { promises as fs } from 'node:fs';


import { setupAsyncTempDirSuite, safePath } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';

import { ResourceRegistry } from '../src/resource-registry.js';

/**
 * Register everything in `dir` by ENUMERATING it, the way a crawl does, rather
 * than from the literals the fixture was written with. That is the whole point
 * for the normalization cases below: the registry key must be whatever the
 * filesystem actually stored, not what the test typed.
 */
async function registerCrawled(registry: ResourceRegistry, dir: string): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const entries = await fs.readdir(dir);
  await registry.addResources(entries.map((entry) => safePath.join(dir, entry)));
}

describe('ResourceRegistry indexes', () => {
  const suite = setupAsyncTempDirSuite('registry-indexes');
  let tempDir: string;
  let registry: ResourceRegistry;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
    // Initialize fresh registry for index tests
    registry = new ResourceRegistry();
  });

  describe('getResourcesByName', () => {
    it('should return empty array for non-existent name', () => {
      const resources = registry.getResourcesByName('nonexistent.md');
      expect(resources).toEqual([]);
    });

    it('should return resources by filename', async () => {
      const file = safePath.join(tempDir, 'test.md');
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await fs.writeFile(file, '# Test', 'utf-8');
      await registry.addResource(file);

      const resources = registry.getResourcesByName('test.md');
      expect(resources).toHaveLength(1);
      expect(resources[0]?.filePath).toBe(file);
    });

    it('should return multiple resources with same name in different directories', async () => {
      const dir1 = safePath.join(tempDir, 'dir1');
      const dir2 = safePath.join(tempDir, 'dir2');
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await fs.mkdir(dir1);
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await fs.mkdir(dir2);
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await fs.writeFile(safePath.join(dir1, 'README.md'), '# Dir 1', 'utf-8');
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await fs.writeFile(safePath.join(dir2, 'README.md'), '# Dir 2', 'utf-8');

      // Use baseDir so same-named files get unique path-relative IDs
      const baseDirRegistry = new ResourceRegistry({ baseDir: tempDir });
      await baseDirRegistry.addResource(safePath.join(dir1, 'README.md'));
      await baseDirRegistry.addResource(safePath.join(dir2, 'README.md'));

      const resources = baseDirRegistry.getResourcesByName('README.md');
      expect(resources).toHaveLength(2);
    });
  });

  /**
   * The path index reconciles Unicode normalization forms — the enumerated-vs-derived
   * path class, collected in docs/architecture/resource-scanning-and-caching.md §3.6.
   *
   * The two sides of `resourcesByPath` come from different places: keys from
   * filesystem enumeration (`readdir` hands back whatever is on disk, commonly
   * decomposed on macOS), queries from markdown link text (composed, as an
   * editor writes it). Exact-string `Map.get` misses, and the link to a file
   * that plainly exists gets no `resolvedId` — which strips the href and fails
   * the build with `PACKAGED_UNREFERENCED_FILE` at packaging time.
   *
   * **The fixture is code-generated, and both forms are escape sequences.** A
   * committed file with an accented name cannot be trusted to arrive
   * decomposed — macOS editors and git checkouts re-normalize — so a committed
   * fixture can silently be NFC on both sides and pin nothing. `readdir` is
   * used to name the file rather than the literal, so the key really is
   * whatever the filesystem stored.
   */
  describe('Unicode normalization of the path index', () => {
    const ON_DISK = 'refe\u0301rence.md';
    const IN_HREF = 'ref\u00E9rence.md';

    beforeEach(async () => {
      // The guard that can fail: `ON_DISK` is really decomposed, and folding
      // it lands exactly on the href spelling. Comparing the two constants to
      // each other is settled at authoring time and pins nothing.
      expect(ON_DISK).not.toBe(ON_DISK.normalize('NFC'));
      expect(ON_DISK.normalize('NFC')).toBe(IN_HREF);
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await fs.writeFile(safePath.join(tempDir, ON_DISK), '# Target\n', 'utf-8');
    });

    /**
     * ⚠️ **Both directions, deliberately.** Normalizing only where the key is
     * written passes a one-directional test — the on-disk name becomes NFC and
     * a composed href matches it without the query ever being normalized. It is
     * the *decomposed href* that pins the lookup side, and a link href really
     * can arrive decomposed (pasted from a macOS listing). Drop either
     * normalization and exactly one row goes red.
     */
    const HREF_FORMS: readonly { label: string; href: string }[] = [
      { label: 'composed', href: IN_HREF },
      { label: 'decomposed', href: ON_DISK },
    ];

    it.each(HREF_FORMS)('resolves a $label link href to the same file', async ({ href }) => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await fs.writeFile(safePath.join(tempDir, 'source.md'), `[t](./${href})\n`, 'utf-8');
      const baseDirRegistry = new ResourceRegistry({ baseDir: tempDir });
      await registerCrawled(baseDirRegistry, tempDir);

      baseDirRegistry.resolveLinks();

      const source = baseDirRegistry.getResource(safePath.join(tempDir, 'source.md'));
      expect(source?.links[0]?.resolvedId).toBeDefined();
    });

    it.each(HREF_FORMS)('answers getResource() for the $label form', async ({ href }) => {
      const baseDirRegistry = new ResourceRegistry({ baseDir: tempDir });
      await registerCrawled(baseDirRegistry, tempDir);

      expect(baseDirRegistry.getResource(safePath.join(tempDir, href))?.filePath).toBe(
        safePath.join(tempDir, ON_DISK),
      );
    });
  });

  describe('getResourcesByChecksum', () => {
    it('should return empty array for non-existent checksum', () => {
      const fakeChecksum = 'a'.repeat(64);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resources = registry.getResourcesByChecksum(fakeChecksum as any);
      expect(resources).toEqual([]);
    });

    it('should return resource by checksum', async () => {
      const file = safePath.join(tempDir, 'test.md');
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await fs.writeFile(file, '# Test Content', 'utf-8');
      const metadata = await registry.addResource(file);

      const resources = registry.getResourcesByChecksum(metadata.checksum);
      expect(resources).toHaveLength(1);
      expect(resources[0]?.filePath).toBe(file);
    });

    it('should return multiple resources with identical content', async () => {
      const identicalContent = '# Identical Content';
      const file1 = safePath.join(tempDir, 'file1.md');
      const file2 = safePath.join(tempDir, 'file2.md');
      await fs.writeFile(file1, identicalContent, 'utf-8'); // eslint-disable-line security/detect-non-literal-fs-filename
      await fs.writeFile(file2, identicalContent, 'utf-8'); // eslint-disable-line security/detect-non-literal-fs-filename

      const meta1 = await registry.addResource(file1);
      await registry.addResource(file2);

      const resources = registry.getResourcesByChecksum(meta1.checksum);
      expect(resources).toHaveLength(2);
      expect(resources.map(r => r.filePath)).toContain(file1);
      expect(resources.map(r => r.filePath)).toContain(file2);
    });
  });
});
