/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */

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

import { mkdtempSync, promises as fs, rmSync } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyCacheControl, registerCacheControl } from '../../src/commands/cache/cache-control.js';
import { clearCacheDirectory, vatCacheRoot } from '../../src/commands/cache/clear.js';
import { createCacheCommand } from '../../src/commands/cache/index.js';
import { createResourcesCommand } from '../../src/commands/resources/index.js';

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

  beforeEach(() => {
    workDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-cache-clear-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('removes a populated cache tree and reports what went', async () => {
    const fake = await createFakeCache(workDir);

    const report = await clearCacheDirectory(fake.root);

    expect(report.status).toBe('success');
    expect(report.existed).toBe(true);
    expect(report.entriesRemoved).toBe(fake.fileCount);
    expect(report.bytesRemoved).toBe(fake.totalBytes);
    expect(report.removed).toEqual([AUTH_TENANT, EXTERNAL_LINKS, 'parse']);
    await expect(fs.access(fake.root)).rejects.toThrow();
  });

  it('succeeds on a directory that does not exist', async () => {
    const missing = safePath.join(workDir, 'never-created');

    const report = await clearCacheDirectory(missing);

    expect(report).toEqual({
      status: 'success',
      cacheDir: missing,
      existed: false,
      removed: [],
      entriesRemoved: 0,
      bytesRemoved: 0,
    });
  });

  it('clears even when caching is disabled', async () => {
    // VAT_CACHE=0 turns reads and writes off. If it also disarmed the cleanup,
    // an operator would be left with a cache they can neither use nor remove.
    await withVatCache(DISABLED, async () => {
      const fake = await createFakeCache(workDir);
      const report = await clearCacheDirectory(fake.root);
      expect(report.existed).toBe(true);
      expect(report.entriesRemoved).toBe(fake.fileCount);
      await expect(fs.access(fake.root)).rejects.toThrow();
    });
  });

  it('reports a partial clear by re-reading the tree, not by trusting the error', async () => {
    // The shared cache root is written by every VAT on the machine, so a delete
    // racing a concurrent run gives up part-way. The error names ONE path and
    // says nothing about the rest, which is why the survivors are read back off
    // disk. Injected here rather than provoked with permissions: a chmod-EACCES
    // fixture is POSIX-only and no-ops as root, so it would be a test that
    // silently stops testing on two of the three platforms this ships to.
    const fake = await createFakeCache(workDir);
    const stubborn = safePath.join(fake.root, 'parse');

    const rm = vi.spyOn(fs, 'rm').mockImplementation(async () => {
      rmSync(safePath.join(fake.root, AUTH_TENANT), { recursive: true, force: true });
      rmSync(safePath.join(fake.root, EXTERNAL_LINKS), { force: true });
      throw Object.assign(new Error(`ENOTEMPTY: directory not empty, rmdir '${stubborn}'`), {
        code: 'ENOTEMPTY',
      });
    });

    try {
      const report = await clearCacheDirectory(fake.root);

      expect(report.status).toBe('partial');
      expect(report.removed).toEqual([AUTH_TENANT, EXTERNAL_LINKS]);
      expect(report.remaining).toEqual(['parse']);
      expect(report.reason).toContain('ENOTEMPTY');
      // The counts describe what actually went. Reporting the pre-delete
      // measurement here would claim the whole cache was reclaimed while most
      // of it is still on disk — the failure this branch exists to prevent.
      expect(report.entriesRemoved).toBeGreaterThan(0);
      expect(report.entriesRemoved).toBeLessThan(fake.fileCount);
      expect(report.bytesRemoved).toBeLessThan(fake.totalBytes);
    } finally {
      rm.mockRestore();
    }
  });

  it('counts an empty cache root as existing, with nothing in it', async () => {
    const empty = safePath.join(workDir, CACHE_DIR_NAME);
    await fs.mkdir(empty, { recursive: true });

    const report = await clearCacheDirectory(empty);

    expect(report.existed).toBe(true);
    expect(report.entriesRemoved).toBe(0);
    expect(report.removed).toEqual([]);
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
 * 🪤 `helpInformation()` renders the built-in sections ONLY: Commander appends
 * an `addHelpText('after', …)` block in `outputHelp()`, and every sentence
 * describing what the caches ARE lives in that block. A test written against
 * `helpInformation()` sees an empty Description section and passes every "does
 * not say X" assertion vacuously.
 *
 * @param path - Subcommand name, or nothing for the group itself
 * @returns The rendered help
 */
function cacheHelpFor(path?: string): string {
  const group = createCacheCommand();
  const target = path === undefined ? group : group.commands.find((command) => command.name() === path);
  if (target === undefined) throw new Error(`no vat cache subcommand named ${String(path)} to render`);

  let captured = '';
  target.configureOutput({ writeOut: (text: string) => { captured += text; } });
  target.outputHelp();
  return captured;
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
