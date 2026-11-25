import { promises as fs } from 'node:fs';

import { normalizedTmpdir, resolveFromImportMeta, safePath } from '@vibe-agent-toolkit/utils';
import { removeScratchDir } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  devNamespaceDigest,
  isVatCacheRootEntryName,
  parseCacheDirectory,
  vatCacheNamespace,
  vatCacheNamespaceRoot,
} from '../src/cache-namespace.js';
import { vatCacheRoot } from '../src/cache-root.js';
import { isProjectionStoreDirectoryName, projectionShapeDigest, projectionStoreDirectoryName } from '../src/projection/store.js';
import { ParseFactsSchema, parseFactsShapeSource, schemaShapeSource } from '../src/schemas/parse-facts.js';
import { SKILL_TEXT_DECLARATION, skillTextDeclarationDigest } from '../src/skill-text/declaration.js';

/**
 * The emitted modules the *removed* build fingerprint used to stat.
 *
 * Kept here and nowhere else: they are no longer an input to anything, so a
 * production constant would be dead weight. The tests still need them by name,
 * because "a rebuild of exactly these files does not move the namespace" is the
 * property this change exists to create.
 */
const REBUILT_MODULE_FILES = [
  'link-parser.js',
  'html-link-parser.js',
  'content-key.js',
  'unresolved-references.js',
  'parse-cache.js',
  // The `.ts` siblings mattered too: under Vitest the old fingerprint fell back
  // to them, so a stability claim that ignored them would be testing half the
  // old behaviour.
  'link-parser.ts',
  'html-link-parser.ts',
  'content-key.ts',
  'unresolved-references.ts',
  'parse-cache.ts',
] as const;

/** Write every module the old fingerprint watched, with the given body. */
async function writeRebuiltModules(dir: string, body: string): Promise<void> {
  await Promise.all(REBUILT_MODULE_FILES.map(async (name) => fs.writeFile(safePath.join(dir, name), body)));
}

/** Stamp a distinct mtime on every module, the way `tsc --build` does. */
async function restampModules(dir: string, epochSeconds: number): Promise<void> {
  await Promise.all(
    REBUILT_MODULE_FILES.map(async (name) => fs.utimes(safePath.join(dir, name), epochSeconds, epochSeconds))
  );
}

/** A stand-in for the shape input, so path-only tests state what they hold fixed. */
const A_SHAPE = '{"type":"object"}';
const A_DECLARATION = skillTextDeclarationDigest(SKILL_TEXT_DECLARATION);

describe('devNamespaceDigest', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'vat-cache-namespace-test-'));
  });

  afterEach(async () => {
    await removeScratchDir(tempDir);
  });

  it('survives a rebuild of every module the old fingerprint watched', async () => {
    // THE property this whole change exists for. The previous implementation
    // mixed size+mtime of exactly these files into the digest, so this test is
    // a negative control by construction: it was RED before, because both the
    // size (different body length) and the mtime move below.
    await writeRebuiltModules(tempDir, 'export const version = 1;');
    const before = devNamespaceDigest(tempDir, A_SHAPE, A_DECLARATION);

    await writeRebuiltModules(tempDir, 'export const version = 2; // rebuilt, and longer than before');
    await restampModules(tempDir, Date.now() / 1000 + 3600);
    const after = devNamespaceDigest(tempDir, A_SHAPE, A_DECLARATION);

    expect(after).toBe(before);
  });

  it('survives the modules disappearing entirely, as during a clean rebuild', async () => {
    // `build:clean` empties dist/ before repopulating it. The old fingerprint
    // recorded each missing module as `<name>:absent`, so mid-clean runs got
    // their own namespace; nothing about a parse fact changed.
    await writeRebuiltModules(tempDir, 'export const version = 1;');
    const populated = devNamespaceDigest(tempDir, A_SHAPE, A_DECLARATION);

    await Promise.all(REBUILT_MODULE_FILES.map(async (name) => fs.rm(safePath.join(tempDir, name))));

    expect(devNamespaceDigest(tempDir, A_SHAPE, A_DECLARATION)).toBe(populated);
  });

  it('depends on the module directory, the entry shape and the skill-text declaration, and NOTHING else', () => {
    // Pins the whole input set, so a fourth input cannot appear quietly. A
    // hand-bumped parser-revision constant was once an argument here and must
    // not return: every input is DERIVED — the path from where this code was
    // resolved, the shape from `ParseFactsSchema` itself, the declaration digest
    // from the patterns the skill-text core applies — so none can fall behind
    // what it stands for. What is left over lives in `vat cache clear` (a change
    // of meaning, at unchanged shape and declaration).
    expect(devNamespaceDigest).toHaveLength(3);
  });

  it('moves when the module directory moves, so two worktrees never share a namespace', () => {
    // The one thing the path component is for. Every worktree reads the same
    // version from the same manifest, so without this, branch A and branch B
    // would collide — precisely when invalidation matters most.
    expect(devNamespaceDigest(safePath.join(tempDir, 'other-worktree'), A_SHAPE, A_DECLARATION)).not.toBe(
      devNamespaceDigest(tempDir, A_SHAPE, A_DECLARATION)
    );
  });

  it('moves when the entry shape moves, so one worktree never mixes two entry formats', () => {
    // The counterpart. Without this input, adding an OPTIONAL field to
    // `ParseFacts` leaves every pre-existing entry valid, correctly keyed and
    // silently missing the new field — the exact defect that shipped once.
    expect(devNamespaceDigest(tempDir, A_SHAPE, A_DECLARATION)).not.toBe(devNamespaceDigest(tempDir, '{"type":"array"}', A_DECLARATION));
  });

  it('moves when the skill-text declaration moves, so a pattern edit never serves the old pattern\'s records', () => {
    // Every markdown entry holds the skill-text core's record, computed under
    // the declaration's patterns. A pattern edit leaves the entry's shape and
    // key unchanged, so only this input sends a dev checkout to a new namespace.
    const edited = skillTextDeclarationDigest({ ...SKILL_TEXT_DECLARATION, h1: /^#[ \t]([^\n]+)$/m });
    expect(edited).not.toBe(A_DECLARATION);
    expect(devNamespaceDigest(tempDir, A_SHAPE, edited)).not.toBe(devNamespaceDigest(tempDir, A_SHAPE, A_DECLARATION));
  });

  it('cannot be confused by moving the boundary between its inputs', () => {
    // Concatenating inputs into one hash without a separator lets ('ab', 'c')
    // and ('a', 'bc') collide. Cheap to get wrong, invisible when wrong.
    expect(devNamespaceDigest(`${tempDir}/x`, 'y', A_DECLARATION)).not.toBe(devNamespaceDigest(tempDir, '/xy', A_DECLARATION));
    expect(devNamespaceDigest(tempDir, `${A_SHAPE}z`, 'w')).not.toBe(devNamespaceDigest(tempDir, A_SHAPE, 'zw'));
  });

  it('is six lowercase hex digits, so it is safe as a path segment', () => {
    expect(devNamespaceDigest(tempDir, A_SHAPE, A_DECLARATION)).toMatch(/^[0-9a-f]{6}$/u);
  });
});

describe('parseFactsShapeSource', () => {
  it('moves when an OPTIONAL field is added — the case validation provably cannot see', () => {
    // `ParseFactsSchema` accepts an entry that predates an optional field and an
    // entry that legitimately lacks one identically, because they are the same
    // bytes (pinned as a negative in parse-cache.test.ts). The remedy is not a
    // better validator; it is not letting the two share a cache directory.
    const withNewOptionalField = ParseFactsSchema.extend({ someLaterAddition: z.string().optional() });

    expect(schemaShapeSource(withNewOptionalField)).not.toBe(parseFactsShapeSource());
  });

  it('ignores a reworded description, so a comment cannot cool the cache', () => {
    // The failure mode this input is designed around: the emitted-module
    // fingerprint it replaces moved on every edit anywhere, which is how one
    // machine accumulated 65 namespaces. Prose is not shape.
    const reworded = ParseFactsSchema.extend({
      estimatedTokenCount: z.number().int().nonnegative().describe('a rewording, and nothing else'),
    });

    expect(schemaShapeSource(reworded)).toBe(parseFactsShapeSource());
  });

  it('represents the recursive heading branch rather than collapsing it to `any`', () => {
    // Guards `$refStrategy: 'root'`. The wrapper's default of 'none' cannot
    // inline `HeadingNode`'s self-reference: it warns on the console and emits
    // `{}` for `children`, which would make every change under that branch
    // invisible here — a silent hole, not a loud one.
    expect(parseFactsShapeSource()).toContain('"$ref"');
  });

  it('is deterministic, so two processes on one build agree', () => {
    expect(parseFactsShapeSource()).toBe(parseFactsShapeSource());
  });
});

describe('vatCacheNamespace', () => {
  it('starts with a semver-shaped version read from the package manifest', () => {
    // Read at runtime rather than compiled in: the version is already written
    // down, so nothing about it needs hand-maintaining.
    expect(vatCacheNamespace()).toMatch(/^\d+\.\d+\.\d+/u);
  });

  it('marks a source checkout as a dev namespace with a short discriminator', () => {
    // The suite necessarily runs from a checkout, never from node_modules — so
    // this is also the installed-vs-dev discrimination, exercised from the dev
    // side. An installed run takes the early return and gets `<version>` alone.
    const namespace = vatCacheNamespace();
    const marker = namespace.lastIndexOf('-dev-');
    expect(marker).toBeGreaterThan(0);
    expect(namespace.slice(marker + '-dev-'.length)).toMatch(/^[0-9a-f]{6}$/u);
  });

  it('derives its discriminator from the exported pure digest, not a private copy', () => {
    // Ties the memoized entry point to the function the tests above exercise:
    // without this, `devNamespaceDigest` could drift into being decoration.
    const moduleDir = safePath.join(resolveFromImportMeta(import.meta.url), '..', '..', 'src');
    expect(vatCacheNamespace().endsWith(`-dev-${devNamespaceDigest(moduleDir, parseFactsShapeSource(), A_DECLARATION)}`)).toBe(true);
  });

  it('is stable within a process, so two lookups cannot disagree', () => {
    expect(vatCacheNamespace()).toBe(vatCacheNamespace());
  });

  it('is a single path segment, so it cannot escape the cache root', () => {
    const namespace = vatCacheNamespace();
    expect(namespace).not.toContain('/');
    expect(namespace).not.toContain('\\');
    expect(namespace).not.toContain('..');
  });
});

describe('cache layout', () => {
  // The test setup points VAT_CACHE_DIR at a per-file directory, so the root is that directory here; the
  // default spelling (`<tmpdir>/.vat-cache`) is pinned in cache-root.integration.test.ts.
  it('keeps the shared root free of the namespace', () => {
    expect(vatCacheRoot()).not.toContain(vatCacheNamespace());
  });

  it('puts build-dependent tenants under the namespace', () => {
    expect(vatCacheNamespaceRoot()).toBe(safePath.join(vatCacheRoot(), vatCacheNamespace()));
    expect(parseCacheDirectory()).toBe(safePath.join(vatCacheNamespaceRoot(), 'parse'));
  });

  it('leaves room beside parse/ for the tenants that come next', () => {
    // A `projection-<shapeDigest>/` store is planned as a sibling. Pinning the shape now means the
    // `cache clear` root derivation (which walks up two levels) stays correct
    // when it lands, rather than being rediscovered then.
    expect(safePath.relative(vatCacheNamespaceRoot(), parseCacheDirectory())).toBe('parse');
  });
});

describe('the names prune may remove', () => {
  it('recognises namespaces of any VAT build and the legacy root link-cache names', () => {
    for (const name of [vatCacheNamespace(), '0.1.42', '0.2.0-rc.17', '0.2.0-rc.17-dev-9f2c1a', 'external-links.json', 'auth-jeff', 'parse']) {
      expect(isVatCacheRootEntryName(name), name).toBe(true);
    }
  });

  it('recognises nothing else, so a foreign entry is never a candidate', () => {
    for (const name of ['CACHEDIR.TAG', 'notes.txt', 'node_modules', '.git', 'src', '1.2', 'v0.1.42', 'parse-old', 'auth-', 'projection-abc']) {
      expect(isVatCacheRootEntryName(name), name).toBe(false);
    }
  });

  it('names this build\'s store from the shape digest, and recognises every shape\'s store', () => {
    expect(projectionStoreDirectoryName()).toBe(`projection-${projectionShapeDigest()}`);
    expect(isProjectionStoreDirectoryName(projectionStoreDirectoryName())).toBe(true);
    expect(isProjectionStoreDirectoryName('projection-000000000000')).toBe(true);
    expect(isProjectionStoreDirectoryName('parse')).toBe(false);
  });
});
