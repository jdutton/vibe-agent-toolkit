/**
 * Where VAT's persistable cache lives (`VAT_CACHE_DIR`), where the link-verdict
 * cache lives instead, and how a cache root is recognised as VAT's before
 * anything deletes it.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';

import { normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { removeScratchDir } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseCacheDirectory, vatCacheNamespace, vatCacheNamespaceRoot } from '../../src/cache-namespace.js';
import {
  VAT_CACHE_DIR_ENV,
  VAT_CACHE_TAG_FILE,
  markVatCacheRoot,
  recogniseVatCacheRoot,
  vatCacheRoot,
  vatLinkCacheDirectory,
} from '../../src/cache-root.js';

/** The standard cache-directory tag another tool (cargo, for one) writes. */
const FOREIGN_TAG = 'Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag created by cargo.\n';

let scratch: string;

beforeEach(async () => {
  scratch = toForwardSlash(await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'vat-cache-root-')));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await removeScratchDir(scratch);
});

describe('vatCacheRoot', () => {
  it('defaults to .vat-cache under the temp directory when VAT_CACHE_DIR is unset', () => {
    vi.stubEnv(VAT_CACHE_DIR_ENV, undefined);
    expect(vatCacheRoot()).toBe(safePath.join(normalizedTmpdir(), '.vat-cache'));
  });

  it('treats an empty VAT_CACHE_DIR as unset', () => {
    vi.stubEnv(VAT_CACHE_DIR_ENV, '');
    expect(vatCacheRoot()).toBe(safePath.join(normalizedTmpdir(), '.vat-cache'));
  });

  it('uses an absolute VAT_CACHE_DIR as the root, whatever its name', () => {
    const chosen = safePath.join(scratch, 'ci-cache');
    vi.stubEnv(VAT_CACHE_DIR_ENV, chosen);
    expect(vatCacheRoot()).toBe(chosen);
  });

  it('resolves a relative VAT_CACHE_DIR against the current directory', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(scratch);
    vi.stubEnv(VAT_CACHE_DIR_ENV, 'rel/cache');
    expect(vatCacheRoot()).toBe(safePath.join(scratch, 'rel', 'cache'));
  });

  it('moves the parse cache and the namespace root with it', () => {
    const chosen = safePath.join(scratch, 'ci-cache');
    vi.stubEnv(VAT_CACHE_DIR_ENV, chosen);
    expect(vatCacheNamespaceRoot()).toBe(safePath.join(chosen, vatCacheNamespace()));
    expect(parseCacheDirectory()).toBe(safePath.join(chosen, vatCacheNamespace(), 'parse'));
  });
});

describe('vatLinkCacheDirectory', () => {
  it('stays under the temp directory and outside VAT_CACHE_DIR', () => {
    const chosen = safePath.join(scratch, 'ci-cache');
    vi.stubEnv(VAT_CACHE_DIR_ENV, chosen);
    expect(vatLinkCacheDirectory()).toBe(safePath.join(normalizedTmpdir(), '.vat-link-cache'));
    expect(vatLinkCacheDirectory().startsWith(`${chosen}/`)).toBe(false);
  });

  it('is not inside the default cache root either', () => {
    vi.stubEnv(VAT_CACHE_DIR_ENV, undefined);
    expect(vatLinkCacheDirectory().startsWith(`${vatCacheRoot()}/`)).toBe(false);
  });
});

describe('markVatCacheRoot', () => {
  it('creates an absent root and tags it', async () => {
    const root = safePath.join(scratch, 'fresh');
    vi.stubEnv(VAT_CACHE_DIR_ENV, root);
    markVatCacheRoot();
    const tag = await fs.readFile(safePath.join(root, VAT_CACHE_TAG_FILE), 'utf-8');
    expect(tag.startsWith('Signature: 8a477f597d28d172789f06886806bc55\n')).toBe(true);
    expect(recogniseVatCacheRoot(root)).toEqual({ kind: 'recognised', by: 'tag' });
  });

  it('tags an existing empty directory', () => {
    const root = safePath.join(scratch, 'empty');
    vi.stubEnv(VAT_CACHE_DIR_ENV, root);
    return fs.mkdir(root).then(() => {
      markVatCacheRoot();
      expect(recogniseVatCacheRoot(root)).toEqual({ kind: 'recognised', by: 'tag' });
    });
  });

  it('never tags a directory that already holds something else', async () => {
    const root = safePath.join(scratch, 'someones-work');
    await fs.mkdir(root);
    await fs.writeFile(safePath.join(root, 'notes.txt'), 'mine');
    vi.stubEnv(VAT_CACHE_DIR_ENV, root);
    markVatCacheRoot();
    await expect(fs.readFile(safePath.join(root, VAT_CACHE_TAG_FILE), 'utf-8')).rejects.toThrow();
    expect(recogniseVatCacheRoot(root).kind).toBe('refused');
  });
});

describe('recogniseVatCacheRoot', () => {
  it('reports an absent root as absent', () => {
    expect(recogniseVatCacheRoot(safePath.join(scratch, 'nope'))).toEqual({ kind: 'absent' });
  });

  it('refuses a directory whose tag another tool wrote', async () => {
    const root = safePath.join(scratch, 'target');
    await fs.mkdir(root);
    await fs.writeFile(safePath.join(root, VAT_CACHE_TAG_FILE), FOREIGN_TAG);
    const recognition = recogniseVatCacheRoot(root);
    expect(recognition.kind).toBe('refused');
    expect(recognition.kind === 'refused' ? recognition.reason : '').toContain(VAT_CACHE_TAG_FILE);
  });

  it('refuses an untagged directory that is not the default location', async () => {
    const root = safePath.join(scratch, 'untagged');
    await fs.mkdir(root);
    expect(recogniseVatCacheRoot(root).kind).toBe('refused');
  });

  it('refuses a tagged directory that contains the current directory', async () => {
    const root = safePath.join(scratch, 'outer');
    vi.stubEnv(VAT_CACHE_DIR_ENV, root);
    markVatCacheRoot();
    const inner = safePath.join(root, 'inner');
    await fs.mkdir(inner);
    vi.spyOn(process, 'cwd').mockReturnValue(inner);
    const recognition = recogniseVatCacheRoot(root);
    expect(recognition.kind).toBe('refused');
    expect(recognition.kind === 'refused' ? recognition.reason : '').toMatch(/current directory/u);
  });

  it('refuses the home directory, the temp directory and the filesystem root', () => {
    for (const protectedDir of [homedir(), normalizedTmpdir(), safePath.resolve('/')]) {
      expect(recogniseVatCacheRoot(protectedDir).kind, protectedDir).toBe('refused');
    }
  });

  it('recognises the default location without a tag (a tree an older VAT wrote)', () => {
    vi.stubEnv(VAT_CACHE_DIR_ENV, undefined);
    const fakeTmp = safePath.join(scratch, 'tmp');
    vi.stubEnv('TMPDIR', fakeTmp);
    vi.stubEnv('TEMP', fakeTmp);
    vi.stubEnv('TMP', fakeTmp);
    const root = vatCacheRoot();
    return fs.mkdir(root, { recursive: true }).then(async () => {
      await fs.writeFile(safePath.join(root, 'external-links.json'), '{}');
      expect(recogniseVatCacheRoot(root)).toEqual({ kind: 'recognised', by: 'default-location' });
    });
  });
});
