/**
 * Where VAT's persistable cache lives (`VAT_CACHE_DIR`), where the link-verdict
 * cache lives instead, and how a cache root is recognised as VAT's before
 * anything deletes it.
 */

import { promises as fs } from 'node:fs';

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

  it.each([
    ['the home directory', /home directory/u, (dir: string): void => { vi.stubEnv('HOME', dir); vi.stubEnv('USERPROFILE', dir); }],
    ['the temp directory itself', /temp directory itself/u, stubTmpdir],
  ] as const)('refuses a tagged root that is %s — the protected rule alone decides it', async (_name, reason, makeProtected) => {
    // Tagged by VAT, so nothing but the protected-location rule can refuse it.
    const root = await taggedRoot('protected');
    makeProtected(root);
    const recognition = recogniseVatCacheRoot(root);
    expect(recognition.kind).toBe('refused');
    expect(recognition.kind === 'refused' ? recognition.reason : '').toMatch(reason);
  });

  it('refuses a tagged root that is the filesystem root — the protected rule alone decides it', async () => {
    // The real `/` is untagged, so it would be refused as untagged even without the rule. A tagged
    // directory whose parent resolves to itself is a filesystem root as the rule sees one.
    const root = await taggedRoot('fs-root');
    const resolve = safePath.resolve.bind(safePath);
    vi.spyOn(safePath, 'resolve').mockImplementation((...paths: string[]) =>
      paths.length === 2 && paths[0] === root && paths[1] === '..' ? root : resolve(...paths),
    );
    const recognition = recogniseVatCacheRoot(root);
    expect(recognition.kind).toBe('refused');
    expect(recognition.kind === 'refused' ? recognition.reason : '').toMatch(/filesystem root/u);
  });

  it('recognises the default location without a tag (a tree an older VAT wrote)', async () => {
    const root = await defaultRootUnder(safePath.join(scratch, 'tmp'));
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(safePath.join(root, 'external-links.json'), '{}');
    expect(recogniseVatCacheRoot(root)).toEqual({ kind: 'recognised', by: 'default-location' });
  });

  it.skipIf(process.platform === 'win32')('refuses a default location that is a symbolic link, tagged target or not', async () => {
    // A link at <tmpdir>/.vat-cache — planted by another user on a shared /tmp, or an old link to a
    // shared disk — must never lend its target the default location's untagged recognition.
    const target = safePath.join(scratch, 'someone-elses');
    await fs.mkdir(target);
    await fs.writeFile(safePath.join(target, 'work.txt'), 'keep');
    const root = await defaultRootUnder(safePath.join(scratch, 'tmp'));
    await fs.symlink(target, root);
    expect(recogniseVatCacheRoot(root).kind).toBe('refused');

    markVatCacheRoot();
    await expect(fs.readFile(safePath.join(target, VAT_CACHE_TAG_FILE), 'utf-8')).rejects.toThrow();
  });

  it.skipIf(process.getuid === undefined)('refuses a default location another user owns', async () => {
    const root = await defaultRootUnder(safePath.join(scratch, 'tmp'));
    await fs.mkdir(root, { recursive: true });
    const realUid = process.getuid?.() ?? 0;
    vi.spyOn(process, 'getuid').mockReturnValue(realUid + 1);
    expect(recogniseVatCacheRoot(root).kind).toBe('refused');
  });

  it('grants the default location only on an exact spelling: a case variant is just an untagged directory', async () => {
    const fakeTmp = safePath.join(scratch, 'tmp');
    await defaultRootUnder(fakeTmp);
    const variant = safePath.join(fakeTmp, '.VAT-Cache');
    await fs.mkdir(variant, { recursive: true });
    await fs.writeFile(safePath.join(variant, 'work.txt'), 'keep');
    expect(recogniseVatCacheRoot(variant).kind).toBe('refused');
  });
});

describe('markVatCacheRoot at a protected location', () => {
  it('does not tag an empty directory that is the home directory', async () => {
    const root = safePath.join(scratch, 'home');
    await fs.mkdir(root);
    vi.stubEnv('HOME', root);
    vi.stubEnv('USERPROFILE', root);
    vi.stubEnv(VAT_CACHE_DIR_ENV, root);
    markVatCacheRoot();
    await expect(fs.readFile(safePath.join(root, VAT_CACHE_TAG_FILE), 'utf-8')).rejects.toThrow();
  });
});

/** Point the temp directory (every platform's variable) at `dir`. */
function stubTmpdir(dir: string): void {
  vi.stubEnv('TMPDIR', dir);
  vi.stubEnv('TEMP', dir);
  vi.stubEnv('TMP', dir);
}

/** Make `fakeTmp` the temp directory, unset VAT_CACHE_DIR, and return the default root under it. */
async function defaultRootUnder(fakeTmp: string): Promise<string> {
  await fs.mkdir(fakeTmp, { recursive: true });
  vi.stubEnv(VAT_CACHE_DIR_ENV, undefined);
  stubTmpdir(fakeTmp);
  return vatCacheRoot();
}

/** A fresh directory VAT has tagged as its cache root. */
async function taggedRoot(name: string): Promise<string> {
  const root = safePath.join(scratch, name);
  await fs.mkdir(root);
  vi.stubEnv(VAT_CACHE_DIR_ENV, root);
  markVatCacheRoot();
  expect(recogniseVatCacheRoot(root)).toEqual({ kind: 'recognised', by: 'tag' });
  return root;
}
