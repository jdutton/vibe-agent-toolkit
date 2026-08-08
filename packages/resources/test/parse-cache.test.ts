import { promises as fs } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { computeContentKey, type KeyedContent } from '../src/content-key.js';
import { type ParseResult, parseMarkdownContent } from '../src/link-parser.js';
import {
  PARSE_CACHE_SCHEMA_VERSION,
  ParseCache,
  type ParseCacheOptions,
  dehydrate,
  parseCacheDirectory,
  rehydrate,
} from '../src/parse-cache.js';

// ---------------------------------------------------------------------------
// Fixtures — external constants, never derived from the code under test.
// ---------------------------------------------------------------------------

/** Exercises every optional ParseResult key markdown can populate. */
const SIMPLE_DOC = `---
title: Simple
tags:
  - a
  - b
---

# Heading One

See [the other doc](./other.md), [ref][label] and [dangling][nope].

## Heading Two

<a id="anchor-target"></a>

[label]: ./target.md
`;

/** Same body, no frontmatter — lets the fact-shape test stand on its own. */
const NO_FRONTMATTER_DOC = `# Heading One

See [the other doc](./other.md), [ref][label] and [dangling][nope].

## Heading Two

<a id="anchor-target"></a>

[label]: ./target.md
`;

/**
 * Frontmatter JSON **cannot** carry. Every value here survives `yaml.parse`
 * but is destroyed (or fatal) under `JSON.stringify`:
 *
 * - `.inf` / `.nan` → `Infinity` / `NaN`, both of which JSON writes as `null`
 * - `!!binary`      → a `Buffer`, which JSON writes as `{type,data}`
 * - a cyclic anchor → `JSON.stringify` **throws**
 *
 * The last one is the sharp edge: a cache that stored the parsed object would
 * not merely corrupt this document, it would silently never cache it. The
 * "fixture can distinguish" test below pins that this is really true of this
 * exact string rather than merely believed.
 */
const EXOTIC_FRONTMATTER_DOC = `---
inf: .inf
nan: .nan
bin: !!binary "R0lGODlh"
cyc: &anchor
  self: *anchor
---

# Exotic

[link](./x.md)
`;

const MALFORMED_FRONTMATTER_DOC = `---
title: [unclosed
---

# Broken
`;

/**
 * `"# Té\\n<0xFF>\\n"` — 8 bytes on disk, of which `0xFF` is not valid UTF-8.
 *
 * Chosen so the three numbers that are interchangeable on ASCII genuinely
 * differ: `byteLength` 8, `content.length` 7, `Buffer.byteLength(content)` 10.
 * On an all-ASCII fixture a `sizeBytes` assertion cannot tell a cache that
 * re-attaches the real byte count from one that re-derives it from the decoded
 * string. Asserted explicitly below, not assumed.
 */
const LOSSY_BYTES = new Uint8Array([0x23, 0x20, 0x54, 0xc3, 0xa9, 0x0a, 0xff, 0x0a]);

const LOSSY_BYTE_LENGTH = 8;
const LOSSY_STRING_LENGTH = 7;
const LOSSY_REENCODED_LENGTH = 10;

const SHARD_LENGTH = 2;

// POSIX permission bits. `chmod` on Windows only toggles the read-only flag,
// so the tests that use these are POSIX-only (see the `skipIf` guards).
const MODE_RO_OWNER = 0o500;
const MODE_RW_OWNER = 0o700;
const PERMISSION_BITS = 0o777;

const isWindows = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function keyedFromBytes(bytes: Uint8Array): KeyedContent {
  return {
    content: Buffer.from(bytes).toString('utf-8'),
    key: computeContentKey(bytes, 'markdown'),
    parserKind: 'markdown',
    byteLength: bytes.byteLength,
  };
}

function keyedFromText(text: string): KeyedContent {
  return keyedFromBytes(new Uint8Array(Buffer.from(text, 'utf-8')));
}

function freshParse(keyed: KeyedContent): ParseResult {
  return parseMarkdownContent(keyed.content, keyed.byteLength);
}

/** Pull the YAML between the leading `---` fences. Test-local on purpose. */
function extractFrontmatter(doc: string): string {
  const match = /^---\n([\S\s]*?)\n---\n/.exec(doc);
  return match?.[1] ?? '';
}

interface ParseCacheTestSuite {
  /** The per-test temp directory (a fresh `mkdtemp` for every test). */
  readonly dir: () => string;
  /** A cache rooted at the temp dir, with an EMPTY env (so no ambient toggle). */
  readonly makeCache: (options?: ParseCacheOptions) => ParseCache;
  /** The path the test independently expects an entry to land at. */
  readonly expectedEntryPath: (key: string) => string;
  /** Parse a doc, `set` it, then `get` it back through a SEPARATE cache instance. */
  readonly roundTrip: (keyed: KeyedContent) => Promise<ParseResult | null>;
}

function setupParseCacheTestSuite(): ParseCacheTestSuite {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'vat-parse-cache-'));
  });

  afterEach(async () => {
    // Restore write permission first: a test that dropped it would otherwise
    // leave a directory `rm` cannot descend into.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only: self-created tempDir
    await fs.chmod(tempDir, MODE_RW_OWNER).catch(() => undefined);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const makeCache = (options: ParseCacheOptions = {}): ParseCache =>
    new ParseCache({ cacheDir: tempDir, env: {}, ...options });

  return {
    dir: () => tempDir,
    makeCache,
    expectedEntryPath: (key: string) =>
      safePath.join(tempDir, key.slice(-SHARD_LENGTH), `${key}.json`),
    roundTrip: async (keyed: KeyedContent) => {
      await makeCache().set(keyed, freshParse(keyed));
      return makeCache().get(keyed);
    },
  };
}

async function readEntry(entryPath: string): Promise<Record<string, unknown>> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only: path under self-created tempDir
  const raw = await fs.readFile(entryPath, 'utf-8');
  return JSON.parse(raw) as Record<string, unknown>;
}

async function writeEntry(entryPath: string, body: string): Promise<void> {
  const shardDir = entryPath.slice(0, entryPath.lastIndexOf('/'));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only: path under self-created tempDir
  await fs.mkdir(shardDir, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only: path under self-created tempDir
  await fs.writeFile(entryPath, body, 'utf-8');
}

/**
 * Write a genuinely valid entry through the cache, then rewrite its envelope.
 *
 * Starting from a real `set()` matters: it means the only thing wrong with the
 * resulting entry is whatever `mutate` changed, so a miss can be attributed to
 * that and nothing else.
 */
async function reseatEntry(
  suite: ParseCacheTestSuite,
  keyed: KeyedContent,
  mutate: (entry: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  await suite.makeCache().set(keyed, freshParse(keyed));
  const entryPath = suite.expectedEntryPath(keyed.key);
  await writeEntry(entryPath, JSON.stringify(mutate(await readEntry(entryPath))));
}

async function exists(target: string): Promise<boolean> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only: path under self-created tempDir
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Fixture distinguishability — these guard every assertion further down.
// ---------------------------------------------------------------------------

describe('fixture distinguishability', () => {
  it('EXOTIC_FRONTMATTER_DOC really produces frontmatter JSON cannot carry', () => {
    const parsed = freshParse(keyedFromText(EXOTIC_FRONTMATTER_DOC));
    const frontmatter = parsed.frontmatter ?? {};

    expect(frontmatter['inf']).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isNaN(frontmatter['nan'])).toBe(true);
    expect(Buffer.isBuffer(frontmatter['bin'])).toBe(true);
    // The whole object is unserializable — which makes "cache the source, not
    // the object" a correctness requirement rather than a preference.
    expect(() => JSON.stringify(frontmatter)).toThrow();
  });

  it('LOSSY_BYTES really makes the three size numbers differ', () => {
    const keyed = keyedFromBytes(LOSSY_BYTES);

    expect(keyed.byteLength).toBe(LOSSY_BYTE_LENGTH);
    expect(keyed.content.length).toBe(LOSSY_STRING_LENGTH);
    expect(Buffer.byteLength(keyed.content, 'utf-8')).toBe(LOSSY_REENCODED_LENGTH);
  });
});

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

describe('parseCacheDirectory', () => {
  it('is a parse/ level beside the other .vat-cache tenants', () => {
    expect(parseCacheDirectory()).toBe(
      safePath.join(normalizedTmpdir(), '.vat-cache', 'parse'),
    );
  });
});

describe('dehydrate', () => {
  it('stores parse facts only — never content, sizeBytes or frontmatter', () => {
    const parsed = freshParse(keyedFromText(NO_FRONTMATTER_DOC));

    const facts = dehydrate(parsed) as Record<string, unknown>;

    expect(Object.keys(facts).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'anchors',
      'estimatedTokenCount',
      'headings',
      'links',
      'unresolvedReferences',
    ]);
    expect('content' in facts).toBe(false);
    expect('sizeBytes' in facts).toBe(false);
    expect('frontmatter' in facts).toBe(false);
  });

  it('carries the frontmatter SOURCE, and never the parsed object', () => {
    const parsed = freshParse(keyedFromText(EXOTIC_FRONTMATTER_DOC));

    const facts = dehydrate(parsed) as Record<string, unknown>;

    expect(facts['frontmatterSource']).toBe(extractFrontmatter(EXOTIC_FRONTMATTER_DOC));
    expect('frontmatter' in facts).toBe(false);
  });
});

describe('rehydrate', () => {
  it('re-attaches content and sizeBytes from the ARGUMENT, not the entry', () => {
    const original = keyedFromText(NO_FRONTMATTER_DOC);
    const other = keyedFromBytes(LOSSY_BYTES);
    const facts = dehydrate(freshParse(original));

    const result = rehydrate(facts, other);

    // Content follows the KeyedContent handed in, not the document the entry
    // was written from.
    expect(result.content).toBe(other.content);
    expect(result.content).not.toBe(original.content);
    // sizeBytes is the real on-disk byte count, NOT a re-derivation from the
    // decoded string (10) nor its UTF-16 length (7).
    expect(result.sizeBytes).toBe(other.byteLength);
    expect(result.sizeBytes).not.toBe(Buffer.byteLength(other.content, 'utf-8'));
    expect(result.sizeBytes).not.toBe(other.content.length);
  });

  it('re-derives exotic frontmatter from the source', () => {
    const keyed = keyedFromText(EXOTIC_FRONTMATTER_DOC);
    const facts = dehydrate(freshParse(keyed));

    const result = rehydrate(facts, keyed);

    expect(result.frontmatter?.['inf']).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isNaN(result.frontmatter?.['nan'])).toBe(true);
    expect(Buffer.isBuffer(result.frontmatter?.['bin'])).toBe(true);
  });

  it('re-derives frontmatterError from a malformed source', () => {
    const keyed = keyedFromText(MALFORMED_FRONTMATTER_DOC);
    const fresh = freshParse(keyed);

    const result = rehydrate(dehydrate(fresh), keyed);

    expect(fresh.frontmatterError).toBeDefined();
    expect(result.frontmatterError).toBe(fresh.frontmatterError);
  });
});

// ---------------------------------------------------------------------------
// The cache itself
// ---------------------------------------------------------------------------

describe('ParseCache round trip', () => {
  const suite = setupParseCacheTestSuite();

  it('returns a result strictly equal to a fresh parse', async () => {
    const keyed = keyedFromText(SIMPLE_DOC);
    const fresh = freshParse(keyed);

    const cached = await suite.roundTrip(keyed);

    expect(cached).toStrictEqual(fresh);
  });

  it('round-trips a document whose frontmatter JSON cannot carry', async () => {
    const keyed = keyedFromText(EXOTIC_FRONTMATTER_DOC);
    const fresh = freshParse(keyed);

    const cached = await suite.roundTrip(keyed);

    expect(cached).not.toBeNull();
    expect(cached?.frontmatter?.['inf']).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isNaN(cached?.frontmatter?.['nan'])).toBe(true);
    expect(Buffer.isBuffer(cached?.frontmatter?.['bin'])).toBe(true);
    expect(cached?.links).toStrictEqual(fresh.links);
  });

  it('re-attaches sizeBytes from the fresh read for lossy-UTF-8 content', async () => {
    const keyed = keyedFromBytes(LOSSY_BYTES);

    const cached = await suite.roundTrip(keyed);

    expect(cached?.sizeBytes).toBe(LOSSY_BYTE_LENGTH);
    expect(cached?.content).toBe(keyed.content);
  });

  it('files the entry under <shard>/<key>.json with the schema envelope', async () => {
    const keyed = keyedFromText(SIMPLE_DOC);
    await suite.makeCache().set(keyed, freshParse(keyed));

    const entry = await readEntry(suite.expectedEntryPath(keyed.key));

    expect(entry['v']).toBe(PARSE_CACHE_SCHEMA_VERSION);
    expect('content' in (entry['facts'] as Record<string, unknown>)).toBe(false);
  });

  it('leaves no temp files behind', async () => {
    const keyed = keyedFromText(SIMPLE_DOC);
    await suite.makeCache().set(keyed, freshParse(keyed));

    const shardDir = safePath.join(suite.dir(), keyed.key.slice(-SHARD_LENGTH));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only: path under self-created tempDir
    const names = await fs.readdir(shardDir);

    expect(names).toEqual([`${keyed.key}.json`]);
  });
});

describe('ParseCache aliasing (D3: never hand out shared objects)', () => {
  const suite = setupParseCacheTestSuite();

  it('mints a fresh object graph per get, so callers cannot alias each other', async () => {
    const keyed = keyedFromText(SIMPLE_DOC);
    const cache = suite.makeCache();
    await cache.set(keyed, freshParse(keyed));

    const first = await cache.get(keyed);
    const second = await cache.get(keyed);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.links).not.toBe(second?.links);
    expect(first?.links[0]).not.toBe(second?.links[0]);
    expect(first?.headings).not.toBe(second?.headings);
  });

  it('keeps one consumer\'s in-place mutation out of the next hit', async () => {
    const keyed = keyedFromText(SIMPLE_DOC);
    const cache = suite.makeCache();
    await cache.set(keyed, freshParse(keyed));

    const first = await cache.get(keyed);
    // Exactly what skill-packager.ts does to links it received from a parse.
    const firstLink = first?.links[0];
    if (firstLink !== undefined) firstLink.resolvedId = 'mutated-by-consumer-a';

    const second = await cache.get(keyed);

    expect(second?.links[0]?.resolvedId).toBeUndefined();
  });
});

describe('ParseCache misses', () => {
  const suite = setupParseCacheTestSuite();

  it('reads a never-written key as a miss', async () => {
    expect(await suite.makeCache().get(keyedFromText(SIMPLE_DOC))).toBeNull();
  });

  it('reads a version mismatch as a miss, not a misparse', async () => {
    const keyed = keyedFromText(SIMPLE_DOC);
    // Everything else about this entry stays valid — only the version moved.
    await reseatEntry(suite, keyed, (entry) => ({ ...entry, v: PARSE_CACHE_SCHEMA_VERSION + 1 }));

    expect(await suite.makeCache().get(keyed)).toBeNull();
  });

  it('reads a missing version as a miss', async () => {
    const keyed = keyedFromText(SIMPLE_DOC);
    await reseatEntry(suite, keyed, (entry) => ({ facts: entry['facts'] }));

    expect(await suite.makeCache().get(keyed)).toBeNull();
  });

  it('reads corrupt JSON as a miss', async () => {
    const keyed = keyedFromText(SIMPLE_DOC);
    await writeEntry(suite.expectedEntryPath(keyed.key), '{ "v": 1, "facts": {');

    expect(await suite.makeCache().get(keyed)).toBeNull();
  });

  it('reads a structurally wrong payload as a miss', async () => {
    const keyed = keyedFromText(SIMPLE_DOC);
    await writeEntry(
      suite.expectedEntryPath(keyed.key),
      JSON.stringify({ v: PARSE_CACHE_SCHEMA_VERSION, facts: { links: 'not-an-array' } }),
    );

    expect(await suite.makeCache().get(keyed)).toBeNull();
  });
});

describe('ParseCache fail-soft writes', () => {
  const suite = setupParseCacheTestSuite();

  it.skipIf(isWindows)('treats an unwritable cache directory as a no-op', async () => {
    const keyed = keyedFromText(SIMPLE_DOC);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only: self-created tempDir
    await fs.chmod(suite.dir(), MODE_RO_OWNER);

    const cache = suite.makeCache();

    await expect(cache.set(keyed, freshParse(keyed))).resolves.toBeUndefined();
    expect(await cache.get(keyed)).toBeNull();
  });
});

describe('ParseCache enable toggle', () => {
  const suite = setupParseCacheTestSuite();

  it('is enabled by default', () => {
    expect(suite.makeCache().enabled).toBe(true);
  });

  it('is disabled by VAT_CACHE=0, and an explicit option still wins', () => {
    expect(suite.makeCache({ env: { VAT_CACHE: '0' } }).enabled).toBe(false);
    expect(suite.makeCache({ env: { VAT_CACHE: '1' } }).enabled).toBe(true);
    expect(suite.makeCache({ env: { VAT_CACHE: '0' }, enabled: true }).enabled).toBe(true);
    expect(suite.makeCache({ enabled: false }).enabled).toBe(false);
  });

  it('does no filesystem IO at all when disabled', async () => {
    const keyed = keyedFromText(SIMPLE_DOC);
    const cacheDir = safePath.join(suite.dir(), 'never-created');
    const cache = suite.makeCache({ cacheDir, enabled: false });

    await expect(cache.set(keyed, freshParse(keyed))).resolves.toBeUndefined();

    expect(await cache.get(keyed)).toBeNull();
    expect(await exists(cacheDir)).toBe(false);
  });
});

describe('ParseCache maintenance', () => {
  const suite = setupParseCacheTestSuite();

  it.skipIf(isWindows)('creates cache directories mode 0700 (POSIX only)', async () => {
    const keyed = keyedFromText(SIMPLE_DOC);
    const cacheDir = safePath.join(suite.dir(), 'nested', 'parse');
    await suite.makeCache({ cacheDir }).set(keyed, freshParse(keyed));

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only: path under self-created tempDir
    const stats = await fs.stat(safePath.join(cacheDir, keyed.key.slice(-SHARD_LENGTH)));

    expect(stats.mode & PERMISSION_BITS).toBe(MODE_RW_OWNER);
  });

  it('clear() removes every entry', async () => {
    const keyed = keyedFromText(SIMPLE_DOC);
    const cache = suite.makeCache();
    await cache.set(keyed, freshParse(keyed));

    await cache.clear();

    expect(await cache.get(keyed)).toBeNull();
    expect(await exists(suite.dir())).toBe(false);
  });
});
