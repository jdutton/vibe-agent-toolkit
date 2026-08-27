/* eslint-disable security/detect-non-literal-fs-filename -- controlled temp fixture tree */
import { mkdtempSync, writeFileSync } from 'node:fs';

import {
  createSymlink,
  mkdirSyncReal,
  normalizedTmpdir,
  safePath,
  symlinkCapability,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';
import { GitTracker, runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { beforeEach, describe, expect, it } from 'vitest';

import { RunContentCache } from '../src/projection/content-cache.js';
import {
  COLLECTION_MIME_CONFLICT,
  collectionMimeConflictCondition,
  collectRealization,
  createCollectionMimeResolver,
  realPathOrNull,
  relativize,
  type CollectionMimeResolver,
  type RealizationContext,
} from '../src/projection/realizations.js';
import { PROJECTION_TABLES } from '../src/projection/table-registry.js';
import type { CollectionConfig } from '../src/schemas/project-config.js';
import type { ResourceRealizationRow } from '../src/schemas/projection-resources.js';
import { RealizationConditionRowSchema, ResourceRealizationRowSchema } from '../src/schemas/projection-resources.js';

// Hoisted: sonarjs/no-duplicate-string blocks a literal used 3+ times.
const EXTENT_ID = 'ctx-filesystem';
const RESOURCE_ID = 'res-0000';
const NESTED_RELATIVE = 'docs/guides/Setup.MD';
const NOWHERE = 'nowhere.md';
/** Named but never created — the fixture the shape cases deliberately contradict. */
const UNWRITTEN = 'never-written.md';
const IGNORED_LOG = 'ignored.log';
const IGNORED_DIR = 'dist';
const DOCS_DIR = 'docs';

let root: string;

/** The parts of a {@link RealizationContext} a case may vary. */
type RealizationOptions = Partial<Pick<
  RealizationContext,
  'contentCache' | 'contentDemand' | 'gitTracker' | 'mimeResolver' | 'observedShape'
>>;

/** Realize a fixture path, varying only the policy inputs a case cares about. */
async function realize(
  relativePath: string,
  options: RealizationOptions = {},
): Promise<ResourceRealizationRow> {
  return collectRealization(safePath.join(root, relativePath), RESOURCE_ID, {
    root,
    extentId: EXTENT_ID,
    ...options,
  });
}

/** The realization of the nested fixture file, which most cases ask about. */
async function nestedRow(): Promise<ResourceRealizationRow> {
  return realize(NESTED_RELATIVE);
}

/**
 * A git oracle over the fixture root, ignoring {@link IGNORED_LOG} and
 * {@link IGNORED_DIR}.
 *
 * No commit is needed — `isIgnored` falls back to `git check-ignore`, which
 * reads `.gitignore` directly.
 */
async function trackerOverFixture(): Promise<GitTracker> {
  writeFileSync(safePath.join(root, '.gitignore'), `${IGNORED_LOG}\n${IGNORED_DIR}/\n`);
  runGitOrThrow(['init'], { cwd: root });
  const tracker = new GitTracker(root);
  await tracker.initialize();
  return tracker;
}

/** Realize a fixture path under the filesystem extent's own demand policy. */
async function ignoreAwareRow(relativePath: string): Promise<ResourceRealizationRow> {
  return realize(relativePath, {
    gitTracker: await trackerOverFixture(),
    contentDemand: 'deferGitignored',
  });
}

/**
 * A cache stand-in whose every read throws, so the `unreadable` branch is
 * reachable on every platform and under every uid.
 *
 * @returns A {@link RunContentCache}-shaped object that always rejects
 */
function throwingCache(): RunContentCache {
  return {
    read: () => Promise.reject(new Error('EACCES: permission denied')),
    stats: { hits: 0, misses: 0, entries: 0, bytesHeld: 0 },
  } as unknown as RunContentCache;
}

beforeEach(() => {
  root = toForwardSlash(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-realization-')));
  mkdirSyncReal(safePath.join(root, 'docs/guides'), { recursive: true });
  mkdirSyncReal(safePath.join(root, IGNORED_DIR), { recursive: true });
  writeFileSync(safePath.join(root, NESTED_RELATIVE), '# setup\n');
  writeFileSync(safePath.join(root, IGNORED_LOG), 'noise\n');
});

describe('collectRealization', () => {
  it('derives the six path columns from the root-relative path', async () => {
    const row = await nestedRow();

    expect(row.path).toBe(NESTED_RELATIVE);
    expect(row.pathLower).toBe('docs/guides/setup.md');
    expect(row.basenameLower).toBe('setup.md');
    expect(row.dir).toBe('docs/guides');
    expect(row.depth).toBe(3);
    expect(row.ext).toBe('.md');
  });

  it('carries the identity and extent it was asked for', async () => {
    const row = await nestedRow();

    expect(row.resourceId).toBe(RESOURCE_ID);
    expect(row.extentId).toBe(EXTENT_ID);
  });

  it('keys the bytes of THIS realization, not of the identity', async () => {
    const row = await nestedRow();

    expect(row.contentKey).toMatch(/^markdown\.[\da-f]{64}$/u);
    expect(row.contentState).toBe('keyed');
  });

  it('reports a live symlink as a symlink that resolves', async ({ skip }) => {
    // Creating a symlink on Windows needs the privilege Developer Mode grants,
    // which CI agents and most dev boxes lack — `symlinkSync` throws EPERM
    // there. Skip loudly rather than no-op: a silently skipped symlink case
    // reads as a passing test. Same gate `fs-utils.test.ts` already uses.
    const cap = symlinkCapability() ?? skip();

    createSymlink(cap, safePath.join(root, NESTED_RELATIVE), safePath.join(root, 'alias.md'));

    const row = await realize('alias.md');

    expect(row.isSymlink).toBe(true);
    expect(row.symlinkResolves).toBe(true);
    expect(row.exists).toBe(true);
  });

  it('reports a dangling symlink as present but unresolving, with no bytes to key', async ({ skip }) => {
    const cap = symlinkCapability() ?? skip();

    createSymlink(cap, safePath.join(root, NOWHERE), safePath.join(root, 'dangling.md'));

    const row = await realize('dangling.md');

    expect(row.exists).toBe(true);
    expect(row.isSymlink).toBe(true);
    expect(row.symlinkResolves).toBe(false);
    expect(row.contentKey).toBeNull();
    // Not "unreadable": nothing was ever attempted, there is simply nothing there.
    expect(row.contentState).toBe('none');
  });

  it('nulls symlinkResolves for a plain file — the schema superRefine requires it', async () => {
    const row = await nestedRow();

    expect(row.isSymlink).toBe(false);
    expect(row.symlinkResolves).toBeNull();
  });

  it('records an absent path without throwing, with mtime null', async () => {
    const row = await realize('missing.md');

    expect(row.exists).toBe(false);
    expect(row.mtime).toBeNull();
    expect(row.contentKey).toBeNull();
    expect(row.contentState).toBe('none');
  });

  it('takes mtime from the lstat that already answered isSymlink', async () => {
    const row = await nestedRow();

    expect(row.mtime).toBeInstanceOf(Date);
    expect(row.mtime?.getTime() ?? Number.NaN).toBeGreaterThan(0);
  });

  it('reports a directory as a directory with no content key', async () => {
    const row = await realize(DOCS_DIR);

    expect(row.isDirectory).toBe(true);
    expect(row.contentKey).toBeNull();
    expect(row.contentState).toBe('none');
    expect(row.ext).toBe('');
    expect(row.dir).toBe('');
    expect(row.depth).toBe(1);
  });

  it('records a read that threw as unreadable — a fact about the corpus, not an abort', async () => {
    // The failure is injected at the cache seam rather than by chmod: EACCES via
    // chmod is POSIX-only and is a no-op when the suite runs as root, which would
    // make this a test that silently stops testing anything.
    const row = await realize(NESTED_RELATIVE, { contentCache: throwingCache() });

    expect(row.exists).toBe(true);
    expect(row.isDirectory).toBe(false);
    expect(row.contentKey).toBeNull();
    expect(row.contentState).toBe('unreadable');
  });

  it('produces a row the shipped schema accepts', async () => {
    const row = await nestedRow();

    expect(() => ResourceRealizationRowSchema.parse(row)).not.toThrow();
  });
});

/**
 * **The shape is authoritative, and these fixtures LIE ON PURPOSE.**
 *
 * A change whose whole effect is "one syscall no longer happens" cannot be
 * guarded by asserting the columns: a correct `lstat` produces the same answers,
 * so an accidental revert stays green. Nor can it be guarded here by spying —
 * `realizations.ts` imports `lstatSync` as an ESM named binding, which
 * `vi.spyOn` cannot replace, and the module-mocking needed to reach it would
 * pin the mechanism rather than the property.
 *
 * So each case below hands `observedShape` a fixture the filesystem CONTRADICTS,
 * and asserts that git's answer survives. A row claiming `exists: true` for a
 * path that is not there is only producible by code that did not look — the
 * `lstat` is proven absent by its consequence, on every platform, with no
 * instrumentation. The negative control at the end runs the identical fixture
 * with no shape and gets the filesystem's answer instead, so a shape that had
 * silently stopped being read would redden here rather than pass twice.
 *
 * ⚠️ This is a unit-level property. What it does NOT show is that a real
 * enumerator supplies shapes for the paths it should; that is measured in
 * `test/integration/git-crawl-io-cost.integration.test.ts`, which counts the
 * `lstat`s a git-sourced extent actually makes.
 */
describe('collectRealization observed shape', () => {
  it('takes the enumerator\'s word that a path exists, without looking', async () => {
    const row = await realize(UNWRITTEN, { observedShape: 'file' });

    expect(row.exists).toBe(true);
    expect(row.isDirectory).toBe(false);
    expect(row.isSymlink).toBe(false);
    expect(row.symlinkResolves).toBeNull();
  });

  it('calls a shape-declared directory a directory, over the file that is really there', async () => {
    const row = await realize(NESTED_RELATIVE, { observedShape: 'directory' });

    expect(row.isDirectory).toBe(true);
    // And the no-bytes rule follows from the shape, not from a second look.
    expect(row.contentKey).toBeNull();
    expect(row.contentState).toBe('none');
  });

  it('leaves mtime null, because nothing stat-ed the path', async () => {
    const row = await realize(NESTED_RELATIVE, { observedShape: 'file' });

    // The file is real and has a real mtime — `takes mtime from the lstat…`
    // above proves the unshaped path reports one — so null here is the skipped
    // stat, not an absent file.
    expect(row.mtime).toBeNull();
    expect(() => ResourceRealizationRowSchema.parse(row)).not.toThrow();
  });

  it('still reads the bytes: the shape replaces the stat, never the content key', async () => {
    const cache = new RunContentCache();

    const row = await realize(NESTED_RELATIVE, { contentCache: cache, observedShape: 'file' });

    expect(row.contentState).toBe('keyed');
    expect(cache.stats.misses).toBe(1);
  });

  it('reports a read that could not happen as unreadable, not as absent', async () => {
    // The lying fixture's honest consequence: the row says the path is there
    // because git said so, and says its bytes could not be keyed because they
    // could not. Two different facts, and the shape only settles the first.
    const row = await realize(UNWRITTEN, { observedShape: 'file' });

    expect(row.exists).toBe(true);
    expect(row.contentState).toBe('unreadable');
  });

  it('stats when no shape is supplied — the control that makes the above mean something', async () => {
    const row = await realize(UNWRITTEN);

    expect(row.exists).toBe(false);
    expect(row.mtime).toBeNull();
  });
});

describe('collectRealization content demand', () => {
  it('keys eagerly when no demand is stated at all', async () => {
    const cache = new RunContentCache();

    const row = await realize(NESTED_RELATIVE, { contentCache: cache });

    expect(row.contentState).toBe('keyed');
    expect(row.contentKey).not.toBeNull();
    // The negative control for the deferral test below: this counter does move.
    expect(cache.stats.misses).toBe(1);
  });

  it('defers every path under "deferred", however readable', async () => {
    const row = await realize(NESTED_RELATIVE, { contentDemand: 'deferred' });

    expect(row.exists).toBe(true);
    expect(row.contentKey).toBeNull();
    expect(row.contentState).toBe('deferred');
  });

  it('does not read the bytes it defers', async () => {
    const cache = new RunContentCache();

    await realize(NESTED_RELATIVE, { contentCache: cache, contentDemand: 'deferred' });

    // Asserting the null key alone could not tell deferral from a read whose
    // result was discarded, which is the entire point of the change.
    expect(cache.stats.misses).toBe(0);
    expect(cache.stats.entries).toBe(0);
  });

  it('defers a gitignored file under "deferGitignored", keeping the row itself intact', async () => {
    const row = await ignoreAwareRow(IGNORED_LOG);

    expect(row.exists).toBe(true);
    expect(row.gitignored).toBe(true);
    expect(row.contentKey).toBeNull();
    expect(row.contentState).toBe('deferred');
  });

  it('keys a non-gitignored file under "deferGitignored"', async () => {
    const row = await ignoreAwareRow(NESTED_RELATIVE);

    expect(row.gitignored).toBe(false);
    expect(row.contentState).toBe('keyed');
    expect(row.contentKey).not.toBeNull();
  });

  it('calls a gitignored directory "none", never "deferred" — no bytes beats any policy', async () => {
    const row = await ignoreAwareRow(IGNORED_DIR);

    expect(row.isDirectory).toBe(true);
    // Genuinely inside the policy's reach: it would defer this path if the
    // no-bytes rule did not take precedence.
    expect(row.gitignored).toBe(true);
    expect(row.contentState).toBe('none');
  });

  it('calls an absent path "none" under a deferring policy', async () => {
    const row = await realize('missing.md', { contentDemand: 'deferred' });

    expect(row.exists).toBe(false);
    expect(row.contentState).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// The `mime` column, and the collections that can override it
// ---------------------------------------------------------------------------

const TEXT_MARKDOWN = 'text/markdown';
const TEXT_TYPESCRIPT = 'text/x-typescript';
const TEXT_CSHARP = 'text/x-csharp';
const SOURCE_FILE = 'src/module.ts';
const OTHER_SOURCE_FILE = 'src/other.ts';
const SOURCE_GLOB = '**/*.ts';
/** TypeScript nothing would mistake for prose. */
const TS_SOURCE = 'export {};\n';
/** Markdown living at a `.ts` path — the case a collection declaration is for. */
const PROSE_SOURCE = '# actually prose\n';
const PROSE_COLLECTION = 'prose';
const CODE_COLLECTION = 'code';
const UNTYPED_COLLECTION = 'untyped';

/** Write a fixture file, creating any directory it needs. */
function writeFixture(relativePath: string, content = 'x\n'): void {
  const lastSlash = relativePath.lastIndexOf('/');
  if (lastSlash !== -1) {
    mkdirSyncReal(safePath.join(root, relativePath.slice(0, lastSlash)), { recursive: true });
  }
  writeFileSync(safePath.join(root, relativePath), content);
}

/** Realize a fixture path through a resolver built over `collections`. */
async function realizeUnder(
  relativePath: string,
  collections: Record<string, CollectionConfig>,
): Promise<{ row: ResourceRealizationRow; resolver: CollectionMimeResolver }> {
  const resolver = createCollectionMimeResolver(collections);
  const row = await realize(relativePath, { mimeResolver: resolver });
  return { row, resolver };
}

describe('the mime column', () => {
  it('types a markdown file from its extension', async () => {
    expect((await nestedRow()).mime).toBe(TEXT_MARKDOWN);
  });

  it('types a file nothing parses — what a file IS is not what runs over it', async () => {
    writeFixture(SOURCE_FILE, TS_SOURCE);

    const row = await realize(SOURCE_FILE);

    expect(row.mime).toBe(TEXT_TYPESCRIPT);
    // The type is recorded; the parser is still none. Both facts, separately.
    expect(row.contentKey).toMatch(/^none\.[\da-f]{64}$/u);
  });

  it('types an extensionless well-known from its basename', async () => {
    writeFixture('README', '# hi\n');

    expect((await realize('README')).mime).toBe('text/plain');
  });

  it('records null for an extension no table names, never application/octet-stream', async () => {
    // The distinction the column exists for: "no type recorded" must stay
    // distinguishable from a known-binary type, so an unknown cannot read as
    // deliberately classified.
    writeFixture('feed.fraud-ingest-job');

    expect((await realize('feed.fraud-ingest-job')).mime).toBeNull();
  });

  it('records null for a directory, which has no type to have', async () => {
    expect((await realize(DOCS_DIR)).mime).toBeNull();
  });

  it('sits beside ext in the registry column order', () => {
    // The projection export pins `Object.keys(row)` against this list, so the
    // column's POSITION is part of the contract, not only its presence.
    const columns = PROJECTION_TABLES.resourceRealizations.columns;

    expect(columns[columns.indexOf('ext') + 1]).toBe('mime');
  });

  it('produces a row the shipped schema accepts', async () => {
    const row = await nestedRow();

    expect(() => ResourceRealizationRowSchema.parse(row)).not.toThrow();
  });
});

describe('collection-declared mime', () => {
  it('routes a .ts file to the markdown parser when a collection says it is markdown', async () => {
    writeFixture(SOURCE_FILE, PROSE_SOURCE);

    const { row } = await realizeUnder(SOURCE_FILE, {
      [PROSE_COLLECTION]: { include: [SOURCE_GLOB], mimeType: TEXT_MARKDOWN },
    });

    expect(row.mime).toBe(TEXT_MARKDOWN);
    // The declaration reaches the parser, not just the column: the key's prefix
    // is what every downstream stage reads the parser kind back off.
    expect(row.contentKey).toMatch(/^markdown\.[\da-f]{64}$/u);
  });

  it('falls through to the extension table when no matching collection declares one', async () => {
    writeFixture(SOURCE_FILE, TS_SOURCE);

    const { row, resolver } = await realizeUnder(SOURCE_FILE, {
      [PROSE_COLLECTION]: { include: ['docs/**/*.md'], mimeType: TEXT_MARKDOWN },
    });

    expect(row.mime).toBe(TEXT_TYPESCRIPT);
    expect(resolver.conflicts).toStrictEqual([]);
  });

  it('takes the one declared value when a second matching collection declares nothing', async () => {
    // The owner's cheapness rule: a collection that matches but declares no
    // mimeType contributes nothing and can NEVER conflict.
    writeFixture(SOURCE_FILE, PROSE_SOURCE);

    const { row, resolver } = await realizeUnder(SOURCE_FILE, {
      [PROSE_COLLECTION]: { include: [SOURCE_GLOB], mimeType: TEXT_MARKDOWN },
      [UNTYPED_COLLECTION]: { include: [SOURCE_GLOB] },
    });

    expect(row.mime).toBe(TEXT_MARKDOWN);
    expect(resolver.conflicts).toStrictEqual([]);
  });

  it('takes the value when many matching collections all declare the SAME one', async () => {
    writeFixture(SOURCE_FILE, PROSE_SOURCE);

    const { row, resolver } = await realizeUnder(SOURCE_FILE, {
      [PROSE_COLLECTION]: { include: [SOURCE_GLOB], mimeType: TEXT_MARKDOWN },
      [CODE_COLLECTION]: { include: ['src/**/*.ts'], mimeType: TEXT_MARKDOWN },
    });

    expect(row.mime).toBe(TEXT_MARKDOWN);
    expect(resolver.conflicts).toStrictEqual([]);
  });
});

describe('collection mime conflicts', () => {
  /** Two collections that type every `.ts` file differently. */
  const disagreeing: Record<string, CollectionConfig> = {
    [PROSE_COLLECTION]: { include: [SOURCE_GLOB], mimeType: TEXT_MARKDOWN },
    [CODE_COLLECTION]: { include: [SOURCE_GLOB], mimeType: TEXT_CSHARP },
  };

  it('reports one conflict naming both collections and both types', async () => {
    writeFixture(SOURCE_FILE, TS_SOURCE);

    const { resolver } = await realizeUnder(SOURCE_FILE, disagreeing);

    expect(resolver.conflicts).toHaveLength(1);
    expect(resolver.conflicts[0]).toStrictEqual({
      path: SOURCE_FILE,
      collections: [PROSE_COLLECTION, CODE_COLLECTION],
      mimeTypes: [TEXT_MARKDOWN, TEXT_CSHARP],
    });
  });

  it('gives the conflicted file the built-in table\'s answer so the report completes', async () => {
    writeFixture(SOURCE_FILE, TS_SOURCE);

    const { row } = await realizeUnder(SOURCE_FILE, disagreeing);

    expect(row.mime).toBe(TEXT_TYPESCRIPT);
    expect(row.contentState).toBe('keyed');
  });

  it('collects BOTH conflicting files rather than throwing on the first', async () => {
    // The collect-don't-throw property. A config authoring error must read like
    // a linter finding — every offending file named — not kill the run on the
    // first one and hide the rest.
    writeFixture(SOURCE_FILE, TS_SOURCE);
    writeFixture(OTHER_SOURCE_FILE, TS_SOURCE);
    const resolver = createCollectionMimeResolver(disagreeing);

    const first = await realize(SOURCE_FILE, { mimeResolver: resolver });
    const second = await realize(OTHER_SOURCE_FILE, { mimeResolver: resolver });

    expect(first.mime).toBe(TEXT_TYPESCRIPT);
    expect(second.mime).toBe(TEXT_TYPESCRIPT);
    expect(resolver.conflicts.map((conflict) => conflict.path))
      .toStrictEqual([SOURCE_FILE, OTHER_SOURCE_FILE]);
  });

  it('reports one conflict per PATH, however many extents realize it', async () => {
    // A resolver outlives one extent, and the same file realized in three of
    // them is one config error, not three.
    writeFixture(SOURCE_FILE, TS_SOURCE);
    const resolver = createCollectionMimeResolver(disagreeing);

    await realize(SOURCE_FILE, { mimeResolver: resolver });
    await realize(SOURCE_FILE, { mimeResolver: resolver });

    expect(resolver.conflicts).toHaveLength(1);
  });

  it('surfaces a conflict as a realization_conditions row the schema accepts', async () => {
    writeFixture(SOURCE_FILE, TS_SOURCE);
    const { resolver } = await realizeUnder(SOURCE_FILE, disagreeing);

    // Mapped rather than indexed, so the length assertion is what establishes
    // there is a row at all — an index plus a non-null assertion would report a
    // TypeError instead of the count that actually went wrong.
    const conditions = resolver.conflicts
      .map((conflict) => collectionMimeConflictCondition(conflict, EXTENT_ID, RESOURCE_ID));
    expect(conditions).toHaveLength(1);

    const condition = conditions[0];
    expect(() => RealizationConditionRowSchema.parse(condition)).not.toThrow();
    expect(condition?.code).toBe(COLLECTION_MIME_CONFLICT);
    expect(condition?.severity).toBe('error');
    expect(condition?.path).toBe(SOURCE_FILE);
    // Named, so an author can open the config and fix it without re-running.
    for (const fragment of [PROSE_COLLECTION, CODE_COLLECTION, TEXT_MARKDOWN, TEXT_CSHARP, SOURCE_FILE]) {
      expect(condition?.message).toContain(fragment);
    }
    // No reference provoked it, and the row says so by name.
    expect(condition?.sourcePath).toBeNull();
    expect(condition?.matchedPayload).toBeNull();
  });
});

describe('relativize', () => {
  it('renders the root itself as "."', () => {
    expect(relativize(root, root)).toBe('.');
  });

  it('forward-slashes a nested path', () => {
    expect(relativize(safePath.join(root, NESTED_RELATIVE), root)).toBe(NESTED_RELATIVE);
  });
});

describe('realPathOrNull', () => {
  it('resolves a symlink to its target rather than reporting the link', ({ skip }) => {
    const cap = symlinkCapability() ?? skip();

    const alias = safePath.join(root, 'alias.md');
    createSymlink(cap, safePath.join(root, NESTED_RELATIVE), alias);

    expect(realPathOrNull(alias)).toBe(realPathOrNull(safePath.join(root, NESTED_RELATIVE)));
  });

  it('returns null for a path that cannot be resolved', () => {
    expect(realPathOrNull(safePath.join(root, NOWHERE))).toBeNull();
  });
});
