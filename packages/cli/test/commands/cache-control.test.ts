/**
 * The cache control surface: root `--no-cache`, and `vat cache clear`.
 *
 * Two things here are worth more than the rest.
 *
 * 1. The root flag is exercised through the REAL registration function
 *    (`registerCacheControl`) and the REAL `vat resources validate` factory,
 *    parsing a real argv. A test that hand-built the option would have stayed
 *    green while `bin.ts` declared something else entirely — and Commander's
 *    `--no-cache` → `opts.cache` shape is exactly the trap that made three
 *    flags in this package silent no-ops (see commander-option-keys.test.ts).
 *
 * 2. Nothing here points at the real `<tmpdir>/.vat-cache`. Every clear runs
 *    against an injected directory, because a test suite that deletes a
 *    developer's or CI's live cache is a bug regardless of whether it passes.
 */

import { promises as fs, rmSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyCacheControl, registerCacheControl } from '../../src/commands/cache/cache-control.js';
import { clearCacheDirectory, vatCacheRoot } from '../../src/commands/cache/clear.js';
import { createCacheCommand } from '../../src/commands/cache/index.js';
import { createResourcesCommand } from '../../src/commands/resources/index.js';
import { renderCommandHelp } from '../help-text-helpers.js';
import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

/** The flag under test, spelled once so a rename cannot half-land. */
const NO_CACHE_FLAG = '--no-cache';
/** The value `--no-cache` writes into the environment. */
const DISABLED = '0';
/** The per-OS-user auth tenant directory, named once for fixture and assertions. */
const AUTH_TENANT = 'auth-someuser';
/** One tenant filename, reused by the fixture and by the expected report. */
const EXTERNAL_LINKS = 'external-links.json';
/** The shared cache root's directory name — the same one production derives. */
const CACHE_DIR_NAME = '.vat-cache';
/** Argv tail shared by every root-flag case, so only the flag position varies. */
const VALIDATE_ARGV = ['resources', 'validate', 'docs'] as const;

/** Bodies that give the fake cache tree a non-zero, exactly-known byte total. */
const ENTRY_BODIES = ['{"v":1}', '{"v":1,"facts":{}}', 'x'] as const;

interface FakeCache {
  root: string;
  totalBytes: number;
  fileCount: number;
}

/**
 * Build a directory shaped like the real shared cache root: a sharded `parse/`
 * tenant, the external-link cache file, and a per-user auth tenant beside them.
 */
async function createFakeCache(parent: string): Promise<FakeCache> {
  const root = safePath.join(parent, CACHE_DIR_NAME);
  const relativeFiles = [
    ['parse', 'ab', 'deadbeefab.json'],
    [AUTH_TENANT, EXTERNAL_LINKS],
    [EXTERNAL_LINKS],
  ];

  let totalBytes = 0;
  for (const [index, segments] of relativeFiles.entries()) {
    const body = ENTRY_BODIES[index % ENTRY_BODIES.length] ?? 'x';
    const file = safePath.join(root, ...segments);
    await fs.mkdir(safePath.join(file, '..'), { recursive: true });
    await fs.writeFile(file, body, 'utf-8');
    totalBytes += Buffer.byteLength(body, 'utf-8');
  }

  return { root, totalBytes, fileCount: relativeFiles.length };
}

/**
 * Parse a real argv through a root program carrying the real cache control, with
 * the real `resources` command group attached.
 *
 * `.exitOverride()` keeps a parse error from killing the test process; the
 * displaced action keeps `validateCommand` (filesystem + `process.exit`) from
 * running. The action still fires, so the preAction hook under test runs.
 */
function parseRoot(argv: string[]): { root: Command; validate: Command } {
  const root = new Command();
  root.name('vat').exitOverride();
  registerCacheControl(root);

  const resources = createResourcesCommand();
  root.addCommand(resources);

  const validate = resources.commands.find((candidate) => candidate.name() === 'validate');
  if (!validate) throw new Error("resources factory no longer exposes a 'validate' subcommand");
  validate.exitOverride();
  validate.action(() => {
    /* displace the real handler */
  });

  root.parse(argv, { from: 'user' });
  return { root, validate };
}

/** Run `body` with VAT_CACHE forced to `value`, restoring the original after. */
async function withVatCache(value: string | undefined, body: () => Promise<void>): Promise<void> {
  const original = process.env['VAT_CACHE'];
  if (value === undefined) delete process.env['VAT_CACHE'];
  else process.env['VAT_CACHE'] = value;
  try {
    await body();
  } finally {
    if (original === undefined) delete process.env['VAT_CACHE'];
    else process.env['VAT_CACHE'] = original;
  }
}

describe('root --no-cache', () => {
  const originalCache = process.env['VAT_CACHE'];

  beforeEach(() => {
    delete process.env['VAT_CACHE'];
  });

  afterEach(() => {
    // Restore exactly: leaking VAT_CACHE=0 would silently disable the parse
    // cache for every test that runs after this file.
    if (originalCache === undefined) delete process.env['VAT_CACHE'];
    else process.env['VAT_CACHE'] = originalCache;
  });

  it('sets VAT_CACHE=0 when passed before the subcommand', () => {
    parseRoot([NO_CACHE_FLAG, ...VALIDATE_ARGV]);
    expect(process.env['VAT_CACHE']).toBe(DISABLED);
  });

  it('sets VAT_CACHE=0 when passed after the subcommand', () => {
    parseRoot([...VALIDATE_ARGV, NO_CACHE_FLAG]);
    expect(process.env['VAT_CACHE']).toBe(DISABLED);
  });

  it('leaves VAT_CACHE unset when the flag is absent', () => {
    parseRoot([...VALIDATE_ARGV]);
    expect(process.env['VAT_CACHE']).toBeUndefined();
  });

  it('records the flag on the POSITIVE key Commander emits, never noCache', () => {
    const { root } = parseRoot([NO_CACHE_FLAG, ...VALIDATE_ARGV]);
    expect(root.opts()).toHaveProperty('cache', false);
    expect(root.opts()).not.toHaveProperty('noCache');
  });

  it('hands the flag down to resources validate, which declares its own --no-cache', () => {
    // The root swallows the subcommand's identically-named flag (no
    // enablePositionalOptions), so without the handoff the external-URL cache
    // would silently stay ON for `vat resources validate --no-cache`.
    const { validate } = parseRoot([...VALIDATE_ARGV, NO_CACHE_FLAG]);
    expect(validate.opts()).toHaveProperty('cache', false);
  });

  it('leaves the subcommand flag alone when the root flag was not passed', () => {
    const { validate } = parseRoot([...VALIDATE_ARGV]);
    expect(validate.opts()).toHaveProperty('cache', true);
  });

  it('does not touch a command that has no cache option of its own', () => {
    const bare = new Command('bare');
    applyCacheControl({ cache: false }, bare);
    expect(bare.opts()).not.toHaveProperty('cache');
    expect(process.env['VAT_CACHE']).toBe(DISABLED);
  });
});

describe('clearCacheDirectory', () => {
  let workDir: string;

  // Every clear here removes recursively: the temp root it could reach is the test's own scratch.
  const scratch = useScratchTmpdir('vat-cache-clear-');
  beforeEach(() => {
    workDir = scratch();
  });

  it('removes a populated cache tree and reports what went', async () => {
    const fake = await createFakeCache(workDir);

    const { data, leftover } = await clearCacheDirectory(fake.root);

    expect(leftover).toBeUndefined();
    expect(data).toEqual({ cacheDir: fake.root, existed: true, removed: [AUTH_TENANT, EXTERNAL_LINKS, 'parse'], entriesRemoved: fake.fileCount, bytesRemoved: fake.totalBytes });
    // Nothing is left at the cache path, nor beside it: the parked tree went too.
    expect(await fs.readdir(workDir)).toEqual([]);
  });

  it('succeeds on a directory that does not exist', async () => {
    const missing = safePath.join(workDir, 'never-created');

    expect(await clearCacheDirectory(missing)).toEqual({ data: { cacheDir: missing, existed: false, removed: [], entriesRemoved: 0, bytesRemoved: 0 } });
  });

  it('clears even when caching is disabled', async () => {
    // VAT_CACHE=0 turns reads and writes off. If it also disarmed the cleanup,
    // an operator would be left with a cache they can neither use nor remove.
    await withVatCache(DISABLED, async () => {
      const fake = await createFakeCache(workDir);
      const { data } = await clearCacheDirectory(fake.root);
      expect(data.existed).toBe(true);
      expect(data.entriesRemoved).toBe(fake.fileCount);
      await expect(fs.access(fake.root)).rejects.toThrow();
    });
  });

  it('removes a cache holding a read-only directory: the removal grants the owner rwx on its way down', async () => {
    // A directory whose entries could not be unlinked used to stop the delete part-way.
    const fake = await createFakeCache(workDir);
    await fs.chmod(safePath.join(fake.root, 'parse', 'ab'), 0o555);

    const { data } = await clearCacheDirectory(fake.root);

    expect(data.entriesRemoved).toBe(fake.fileCount);
    expect(await fs.readdir(workDir)).toEqual([]);
  });

  it('a removal the OS stops after the cache left its path is a leftover naming the parked tree, the clear done', async () => {
    // The cache is moved off its path whole before it is removed: there is no "part of the cache"
    // left where the next run looks — the clear is done — and the failure names where the rest is.
    const fake = await createFakeCache(workDir);
    const realRm = fs.rm;
    const rm = vi.spyOn(fs, 'rm').mockImplementation(async (target, ...rest) => {
      if (String(target).endsWith('.previous')) throw Object.assign(new Error(`EBUSY: resource busy or locked, rm '${String(target)}'`), { code: 'EBUSY', syscall: 'rm', path: String(target) });
      return (realRm as (...args: unknown[]) => Promise<void>)(target, ...rest);
    });
    let outcome;
    try {
      outcome = await clearCacheDirectory(fake.root);
    } finally {
      rm.mockRestore();
    }

    const refused = outcome.leftover;
    expect(refused).toMatchObject({ code: 'FS_FAULT', side: 'destination', faultClass: 'busy' });
    expect(outcome.data).toMatchObject({ existed: true, entriesRemoved: fake.fileCount });
    await expect(fs.access(fake.root)).rejects.toThrow();
    const parked = (await fs.readdir(workDir)).find((name) => name.endsWith('.previous'));
    expect(parked).toBeDefined();
    expect(String(refused)).toContain(parked);
  });

  it('refuses a cache root whose listing says ENOENT while its parent still lists it, removing nothing', async () => {
    // "Absent" is believed only when the parent agrees: a listing the OS refused as ENOENT used to
    // read as "no cache" — existed: false, exit 0, the whole cache still on disk.
    const fake = await createFakeCache(workDir);
    const realReaddir = fs.readdir;
    const readdir = vi.spyOn(fs, 'readdir').mockImplementation(async (target, ...rest) => {
      if (String(target) === fake.root) throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${fake.root}'`), { code: 'ENOENT' });
      return (realReaddir as (...args: unknown[]) => Promise<never>)(target, ...rest);
    });
    try {
      await expect(clearCacheDirectory(fake.root)).rejects.toMatchObject({ code: 'FS_FAULT', side: 'environment' });
    } finally {
      readdir.mockRestore();
    }
    expect(await fs.readdir(fake.root)).toHaveLength(3);
  });

  // Every VAT on the machine shares this tree: another clear can take it after the plan saw it. Gone
  // is the goal state — a clear of nothing, never a refusal.
  it.each([
    ['listed', 'readdir'],
    ['moved aside', 'rename'],
  ] as const)('reports a cache another clear removed before it was %s as existed: false', async (_when, method) => {
    const fake = await createFakeCache(workDir);
    const real = fs[method] as (...args: unknown[]) => Promise<unknown>;
    const raced = vi.spyOn(fs, method).mockImplementation((async (target: unknown, ...rest: unknown[]) => {
      if (String(target) !== fake.root) return real(target, ...rest);
      rmSync(fake.root, { recursive: true, force: true });
      throw Object.assign(new Error(`ENOENT: no such file or directory, ${method} '${fake.root}'`), { code: 'ENOENT', path: fake.root });
    }) as never);
    try {
      expect(await clearCacheDirectory(fake.root)).toEqual({ data: { cacheDir: fake.root, existed: false, removed: [], entriesRemoved: 0, bytesRemoved: 0 } });
    } finally {
      raced.mockRestore();
    }
    expect(await fs.readdir(workDir)).toEqual([]);
  });

  it('measures a file that really vanished mid-walk as nothing, and one the OS refuses as a failure', async () => {
    // A concurrent run pruning its own temp file is the case the 0 is for. A
    // refused stat used to read as the same 0 — an entry that is still there,
    // reported as reclaimed, and about to fail the delete anyway.
    const fake = await createFakeCache(workDir);
    const realLstat = fs.lstat;
    const vanished = safePath.join(fake.root, 'parse', 'gone.bin');
    await fs.writeFile(vanished, Buffer.alloc(64));
    const lstat = vi.spyOn(fs, 'lstat').mockImplementation(async (target, ...rest) => {
      if (String(target) === vanished) {
        // Really gone: the parent no longer lists it, so its ENOENT is believed.
        rmSync(vanished);
        throw Object.assign(new Error('ENOENT: vanished'), { code: 'ENOENT' });
      }
      return (realLstat as (...args: unknown[]) => Promise<never>)(target, ...rest);
    });
    try {
      const { data } = await clearCacheDirectory(fake.root);
      // The vanished file was listed (so it counts as an entry) but weighs nothing.
      expect(data.entriesRemoved).toBe(fake.fileCount + 1);
      expect(data.bytesRemoved).toBe(fake.totalBytes);
    } finally {
      lstat.mockRestore();
    }

    const refused = await createFakeCache(workDir);
    const denied = vi.spyOn(fs, 'lstat').mockImplementation(async (target, ...rest) => {
      if (String(target).startsWith(`${refused.root}/`)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return (realLstat as (...args: unknown[]) => Promise<never>)(target, ...rest);
    });
    try {
      // Refused, and classified at the entry as VAT's own cache (environment) — never "reclaimed", never INTERNAL_ERROR.
      await expect(clearCacheDirectory(refused.root)).rejects.toMatchObject({ code: 'FS_FAULT', side: 'environment', faultClass: 'refused' });
    } finally {
      denied.mockRestore();
    }
    expect(await fs.readdir(refused.root)).toHaveLength(3);
  });

  it('counts an empty cache root as existing, with nothing in it', async () => {
    const empty = safePath.join(workDir, CACHE_DIR_NAME);
    await fs.mkdir(empty, { recursive: true });

    const { data } = await clearCacheDirectory(empty);

    expect(data.existed).toBe(true);
    expect(data.entriesRemoved).toBe(0);
    expect(data.removed).toEqual([]);
  });
});

describe('vatCacheRoot', () => {
  it('is the .vat-cache directory that holds the parse tenant', () => {
    // Asserted structurally rather than against a literal: the real value is
    // realpath-normalized, and nothing here is allowed to delete it.
    expect(vatCacheRoot().endsWith(`/${CACHE_DIR_NAME}`)).toBe(true);
  });
});

/**
 * The help for one command in the `cache` group, as a user would read it.
 *
 * @param path - Subcommand name, or nothing for the group itself
 * @returns The rendered help
 */
function cacheHelpFor(path?: string): string {
  const group = createCacheCommand();
  const target = path === undefined ? group : group.commands.find((command) => command.name() === path);
  if (target === undefined) throw new Error(`no vat cache subcommand named ${String(path)} to render`);

  return renderCommandHelp(target);
}

describe('vat cache help text', () => {
  it.each([
    ['the group', undefined],
    ['clear', 'clear'],
  ])('names the projection store among the caches it describes (%s)', (_description, path) => {
    // The store is a real tenant of `<tmpdir>/.vat-cache` — measured at 9.8 MB
    // after ONE run of `vat resources validate` on this repository, and 58.5 MB
    // after five edits. `vat cache clear` did reclaim it, but only incidentally,
    // by removing the whole root; the text a user reads enumerated the other
    // three and never mentioned it, so the one cache big enough to send someone
    // to this command was the one the command did not admit to holding.
    expect(cacheHelpFor(path)).toMatch(/projection store/i);
  });

  it('does not still claim there are three caches', () => {
    // A count in prose is a claim that goes stale the moment a tenant is added,
    // and this one already had. Asserted separately from the presence check
    // above so an edit that appends "and the projection store" to a sentence
    // beginning "three disposable caches" cannot go green.
    expect(cacheHelpFor()).not.toMatch(/three disposable caches/i);
  });
});
