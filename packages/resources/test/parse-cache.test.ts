import { promises as fs } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { computeContentKey, type KeyedContent, type ParserKind } from '../src/content-key.js';
import { parseHtmlContent } from '../src/html-link-parser.js';
import { type ParseResult, parseMarkdownContent } from '../src/link-parser.js';
import {
  ParseCache,
  type ParseCacheOptions,
  type ParseFacts,
  defaultParseCache,
  dehydrate,
  parseCacheDirectory,
  parseKeyed,
  rehydrate,
  vatCacheNamespace,
  vatCacheNamespaceRoot,
  vatCacheRoot,
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

/**
 * Two reference candidates the markdown AST cannot produce: an `@`-prefixed
 * token, and a variable-anchored path inside a code span.
 *
 * The code span is the load-bearing half for a *serialization* test: it makes
 * `inCodeSpan` true and `variableExpansion` non-null on the second row, so a
 * round trip that dropped or defaulted either boolean/enum column would be
 * visible rather than coincidentally equal.
 */
const LEXICAL_DOC = '@docs/x.md\n\nUse `${CLAUDE_PLUGIN_ROOT}/s.js` here.\n';

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

/**
 * One document the two parsers read differently.
 *
 * `parseKeyed` picks its parser off `keyed.parserKind`, and a dispatch test is
 * worthless unless the two branches can produce different answers on the same
 * bytes. The markdown parser reads `[text](href)` and treats the raw `<a>` as
 * opaque HTML; parse5 reads the `<a href>` and treats the bracket syntax as
 * literal text. The "fixture distinguishability" test below pins that this is
 * really true of this exact string rather than merely believed.
 */
const DUAL_PARSER_DOC = `# Dual

[markdown syntax](./markdown-only.md)

<a href="./html-only.md">html syntax</a>
`;

const MARKDOWN_ONLY_HREF = './markdown-only.md';
const HTML_ONLY_HREF = './html-only.md';

/**
 * Fails {@link ParseCache}'s safe-key charset — it contains path separators, so
 * a cache that used it unchecked could read and write outside its own tree.
 */
const UNSAFE_KEY = '../escape/attempt';

const LOSSY_BYTE_LENGTH = 8;
const LOSSY_STRING_LENGTH = 7;
const LOSSY_REENCODED_LENGTH = 10;

const SHARD_LENGTH = 2;

// POSIX permission bits. `chmod` on Windows only toggles the read-only flag,
// so the tests that use these are POSIX-only (see the `skipIf` guards).
const MODE_RO_OWNER = 0o500;
const MODE_RW_OWNER = 0o700;
const PERMISSION_BITS = 0o777;
const MODE_WORLD_WRITABLE = 0o777;

const isWindows = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function keyedFromBytes(bytes: Uint8Array, parserKind: ParserKind = 'markdown'): KeyedContent {
  return {
    content: Buffer.from(bytes).toString('utf-8'),
    key: computeContentKey(bytes, parserKind),
    parserKind,
    byteLength: bytes.byteLength,
  };
}

function keyedFromText(text: string, parserKind: ParserKind = 'markdown'): KeyedContent {
  return keyedFromBytes(new Uint8Array(Buffer.from(text, 'utf-8')), parserKind);
}

function freshParse(keyed: KeyedContent): ParseResult {
  return parseMarkdownContent(keyed.content, keyed.byteLength);
}

function hrefsOf(result: ParseResult): string[] {
  return result.links.map((link) => link.href);
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

/**
 * Rewrite the first stored link of an entry, leaving everything else intact.
 *
 * The element-shape cases need to corrupt exactly one field of exactly one
 * array member. An entry that is wrong at the top level proves nothing about
 * whether the validator ever looks *inside* an array — which is precisely what
 * the predicate this schema replaced never did.
 */
function withFirstLink(
  entry: Record<string, unknown>,
  mutate: (link: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const facts = entry['facts'] as { links: Record<string, unknown>[] };
  const [first, ...rest] = facts.links;
  if (first === undefined) throw new Error('fixture has no stored link to rewrite');
  return { ...entry, facts: { ...facts, links: [mutate(first), ...rest] } };
}

/** `link` without the named keys — the "this entry predates the field" arrangement. */
function withoutKeys(
  link: Record<string, unknown>,
  ...dropped: readonly string[]
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(link).filter(([key]) => !dropped.includes(key)));
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

/**
 * Every route by which `get` returns nothing, as an arrangement a test drives.
 *
 * They are one table rather than five tests because the claim under test is the
 * same for all of them: the caller has to parse, so the counter has to move.
 * Two of these never touch the disk at all (the unusable key and the disabled
 * cache), which is exactly why they are easy to forget to count.
 */
interface MissRoute {
  readonly name: string;
  readonly arrange: (
    suite: ParseCacheTestSuite,
  ) => Promise<{ cache: ParseCache; keyed: KeyedContent }>;
}

const MISS_ROUTES: readonly MissRoute[] = [
  {
    name: 'an entry that was never written',
    arrange: (suite) =>
      Promise.resolve({ cache: suite.makeCache(), keyed: keyedFromText(SIMPLE_DOC) }),
  },
  {
    name: 'an entry that is corrupt JSON',
    arrange: async (suite) => {
      const keyed = keyedFromText(SIMPLE_DOC);
      await writeEntry(suite.expectedEntryPath(keyed.key), '{ "v": 1, "facts": {');
      return { cache: suite.makeCache(), keyed };
    },
  },
  {
    name: 'an entry whose facts are structurally wrong',
    arrange: async (suite) => {
      const keyed = keyedFromText(SIMPLE_DOC);
      await reseatEntry(suite, keyed, () => ({ facts: { links: 'not-an-array' } }));
      return { cache: suite.makeCache(), keyed };
    },
  },
  {
    // The hole the hand-written predicate left, and the reason a schema
    // replaced it: `Array.isArray(links)` is satisfied by an array of anything.
    name: 'an entry whose stored link is the wrong shape inside the array',
    arrange: async (suite) => {
      const keyed = keyedFromText(SIMPLE_DOC);
      await reseatEntry(suite, keyed, (entry) =>
        withFirstLink(entry, (link) => ({ ...link, line: 'not-a-number' })));
      return { cache: suite.makeCache(), keyed };
    },
  },
  {
    // `.strict()` on the envelope: an entry carrying a fact this build has no
    // field for disagrees about what an entry *contains*, which is worth a
    // reparse. This is the direction that catches a field REMOVAL.
    name: 'an entry carrying a fact this build does not know',
    arrange: async (suite) => {
      const keyed = keyedFromText(SIMPLE_DOC);
      await reseatEntry(suite, keyed, (entry) => ({
        ...entry,
        facts: { ...(entry['facts'] as Record<string, unknown>), retiredFact: [] },
      }));
      return { cache: suite.makeCache(), keyed };
    },
  },
  {
    name: 'a key outside the safe charset',
    arrange: (suite) =>
      Promise.resolve({
        cache: suite.makeCache(),
        keyed: { ...keyedFromText(SIMPLE_DOC), key: UNSAFE_KEY },
      }),
  },
  {
    name: 'a cache constructed disabled',
    arrange: (suite) =>
      Promise.resolve({
        cache: suite.makeCache({ enabled: false }),
        keyed: keyedFromText(SIMPLE_DOC),
      }),
  },
];

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

  it('DUAL_PARSER_DOC really makes the two parsers disagree', () => {
    const keyed = keyedFromText(DUAL_PARSER_DOC);

    const asMarkdown = hrefsOf(parseMarkdownContent(keyed.content, keyed.byteLength));
    const asHtml = hrefsOf(parseHtmlContent(keyed.content, keyed.byteLength));

    // Each parser sees exactly the link the other one cannot. Without this, a
    // dispatch assertion would pass under a parser chosen at random.
    expect(asMarkdown).toContain(MARKDOWN_ONLY_HREF);
    expect(asMarkdown).not.toContain(HTML_ONLY_HREF);
    expect(asHtml).toContain(HTML_ONLY_HREF);
    expect(asHtml).not.toContain(MARKDOWN_ONLY_HREF);
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
  it('sits under a per-build namespace, not directly beside the other tenants', () => {
    expect(parseCacheDirectory()).toBe(
      safePath.join(normalizedTmpdir(), '.vat-cache', vatCacheNamespace(), 'parse'),
    );
  });

  it('leaves the build-independent tenants OUTSIDE the namespace', () => {
    // URL reachability and fetched link content are facts about the world, not
    // about this build. Namespacing them would re-fetch on every VAT upgrade.
    expect(vatCacheRoot()).toBe(safePath.join(normalizedTmpdir(), '.vat-cache'));
    expect(parseCacheDirectory().startsWith(vatCacheRoot())).toBe(true);
    expect(vatCacheNamespaceRoot()).not.toBe(vatCacheRoot());
  });
});

describe('dehydrate', () => {
  it('stores parse facts only — never content, sizeBytes or frontmatter', () => {
    const parsed = freshParse(keyedFromText(NO_FRONTMATTER_DOC));

    const facts = dehydrate(parsed) as Record<string, unknown>;

    expect(Object.keys(facts).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'anchors',
      'contentMeasures',
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

describe('dehydrate / rehydrate — lexical references', () => {
  it('round-trips lexical references exactly', () => {
    const keyed = keyedFromText(LEXICAL_DOC);
    const parsed = freshParse(keyed);

    // Through real JSON, not through the object. `structuredClone` would NOT
    // do here even though it is the usual deep-copy answer: an entry on disk is
    // a JSON *string*, and JSON is the encoding that drops undefined-valued
    // keys. Naming the string is the point of the test, not an artifact of it.
    const serialized = JSON.stringify(dehydrate(parsed));
    const revived = rehydrate(JSON.parse(serialized) as ParseFacts, keyed);

    // Not a vacuous pass: the fixture really does produce rows, and the second
    // one really does carry the two columns a defaulting round trip would flip.
    expect(parsed.lexicalReferences).toHaveLength(2);
    expect(revived.lexicalReferences?.[1]?.inCodeSpan).toBe(true);
    expect(revived.lexicalReferences?.[1]?.variableExpansion).toBe('brace');
    expect(revived.lexicalReferences).toStrictEqual(parsed.lexicalReferences);
  });

  it('sets no own key valued undefined when a document has no lexical references', () => {
    const facts = dehydrate(freshParse(keyedFromText('# Title\n')));

    expect(Object.hasOwn(facts, 'lexicalReferences')).toBe(false);
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

  it('files the entry under <shard>/<key>.json carrying facts and no version', async () => {
    const keyed = keyedFromText(SIMPLE_DOC);
    await suite.makeCache().set(keyed, freshParse(keyed));

    const entry = await readEntry(suite.expectedEntryPath(keyed.key));

    // No `v`: the namespace directory separates builds, so an envelope version
    // would be a second, hand-maintained answer to the same question.
    expect('v' in entry).toBe(false);
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

    // Both reads have to have been HITS. Without this line an always-miss cache
    // passes the assertion below for the wrong reason — `second` is `null`, so
    // the optional chain yields `undefined` and the mutation is "not visible"
    // because nothing was returned at all. Verified against that mutant.
    expect(cache.stats).toStrictEqual({ hits: 2, misses: 0, writeFailures: 0 });
    expect(second?.links[0]?.resolvedId).toBeUndefined();
  });
});

describe('ParseCache misses', () => {
  const suite = setupParseCacheTestSuite();

  it('reads a never-written key as a miss', async () => {
    expect(await suite.makeCache().get(keyedFromText(SIMPLE_DOC))).toBeNull();
  });

  it('reads a structurally wrong payload as a miss', async () => {
    const keyed = keyedFromText(SIMPLE_DOC);
    await writeEntry(
      suite.expectedEntryPath(keyed.key),
      JSON.stringify({ facts: { links: 'not-an-array' } }),
    );

    expect(await suite.makeCache().get(keyed)).toBeNull();
  });
});

describe('ParseFactsSchema — the boundary, and the one thing it cannot see', () => {
  const suite = setupParseCacheTestSuite();

  it('CANNOT tell an entry written before an OPTIONAL field from one that never had it', async () => {
    // The honest negative, pinned so nobody reads the schema as total coverage.
    // `ResourceLink.startOffset` is optional because remark reports no position
    // for a quoted, parenthesised GFM autolink — so "this entry predates the
    // span columns" and "this link never had one" are the same bytes, and no
    // validator can separate them. The answer to that class is one level up:
    // `parseFactsShapeSource()` feeds the schema's shape into the cache
    // namespace, so entries from before the field never sit in the same
    // directory as entries from after it. See schemas/parse-facts.ts.
    const keyed = keyedFromText(SIMPLE_DOC);

    // Fixture guard: deleting a field the fixture never carried would make this
    // pass for the wrong reason.
    expect(freshParse(keyed).links[0]?.startOffset).toEqual(expect.any(Number));

    await reseatEntry(suite, keyed, (entry) =>
      withFirstLink(entry, (link) => withoutKeys(link, 'startOffset', 'endOffset')));

    const hit = await suite.makeCache().get(keyed);

    expect(hit).not.toBeNull();
    expect(hit?.links[0]?.startOffset).toBeUndefined();
  });

  it('strips an unknown key from INSIDE an element rather than rejecting the entry', async () => {
    // The counterpart to the envelope's `.strict()`: a stale field on a link is
    // a field this build no longer reads, which harms nothing. Turning every
    // such entry cold would spend a reparse on a change that cannot produce a
    // wrong answer.
    const keyed = keyedFromText(SIMPLE_DOC);
    await reseatEntry(suite, keyed, (entry) =>
      withFirstLink(entry, (link) => ({ ...link, retiredColumn: 'stale' })));

    const hit = await suite.makeCache().get(keyed);

    expect(hit).not.toBeNull();
    expect(hit?.links[0]).not.toHaveProperty('retiredColumn');
  });
});

describe('ParseCache SAFE_KEY rejects traversal (not just separators)', () => {
  const suite = setupParseCacheTestSuite();

  // A charset like `[\w.-]+` accepts the string '..' outright — `.` and `-`
  // are both in it, and two dots in a row are not specially excluded. Unlike
  // UNSAFE_KEY above (which already contains a `/` and so is rejected by even
  // the loosest separator check), this key is chosen to pass a charset-only
  // regex and prove the traversal case specifically.
  const DOT_DOT_KEY = '..';

  it('treats a key of exactly ".." as unsafe, never escaping the cache directory', async () => {
    const cacheDir = safePath.join(suite.dir(), 'nested', 'cache');
    const cache = suite.makeCache({ cacheDir });
    const keyed = { ...keyedFromText(SIMPLE_DOC), key: DOT_DOT_KEY };

    await cache.set(keyed, freshParse(keyed));

    // A safe implementation never touches the filesystem for an unsafe key —
    // not even the parent of `cacheDir` should have been created, let alone a
    // file escaping one level above it (`shardDir` for key '..' computes to
    // `cacheDir/..`, i.e. `nested/`, one level outside `cacheDir` itself).
    expect(await exists(safePath.join(suite.dir(), 'nested'))).toBe(false);
  });

  it('reads a key of exactly ".." as a miss', async () => {
    const keyed = { ...keyedFromText(SIMPLE_DOC), key: DOT_DOT_KEY };

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

  it.skipIf(isWindows)(
    'counts a failed write in writeFailures, so it stays distinguishable from a cold cache',
    async () => {
      const keyed = keyedFromText(SIMPLE_DOC);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only: self-created tempDir
      await fs.chmod(suite.dir(), MODE_RO_OWNER);

      const cache = suite.makeCache();
      await cache.set(keyed, freshParse(keyed));

      // Without a separate counter, this looks byte-identical to a
      // legitimately-cold cache that has simply never been written to.
      expect(cache.stats).toStrictEqual({ hits: 0, misses: 0, writeFailures: 1 });
    },
  );

  it.skipIf(isWindows)(
    'refuses to persist into a pre-existing world/group-writable shard directory',
    async () => {
      const keyed = keyedFromText(SIMPLE_DOC);
      const cacheDir = safePath.join(suite.dir(), 'cache');
      const cache = suite.makeCache({ cacheDir });
      const shardDir = safePath.join(cacheDir, keyed.key.slice(-SHARD_LENGTH));

      // Simulate another local user pre-creating the shard directory, wide
      // open, before VAT ever touches it. `mkdir`'s mode is masked by the
      // process umask, so force it with an explicit `chmod`.
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only: path under self-created tempDir
      await fs.mkdir(shardDir, { recursive: true, mode: MODE_WORLD_WRITABLE });
      // eslint-disable-next-line security/detect-non-literal-fs-filename, sonarjs/file-permissions -- test-only: intentionally world-writable to simulate a hostile pre-created shard dir
      await fs.chmod(shardDir, MODE_WORLD_WRITABLE);

      await cache.set(keyed, freshParse(keyed));

      expect(cache.stats).toStrictEqual({ hits: 0, misses: 0, writeFailures: 1 });
      expect(await cache.get(keyed)).toBeNull();
    },
  );
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

// ---------------------------------------------------------------------------
// Observability — without these counters every equivalence test below is
// theatre: a cache that never hits returns byte-identical results to one that
// always does.
// ---------------------------------------------------------------------------

describe('ParseCache stats', () => {
  const suite = setupParseCacheTestSuite();

  it('starts at zero on a fresh instance', () => {
    expect(suite.makeCache().stats).toStrictEqual({ hits: 0, misses: 0, writeFailures: 0 });
  });

  it('counts the miss first, then counts the hit that follows it', async () => {
    const keyed = keyedFromText(SIMPLE_DOC);
    const cache = suite.makeCache();

    expect(await cache.get(keyed)).toBeNull();
    expect(cache.stats).toStrictEqual({ hits: 0, misses: 1, writeFailures: 0 });

    await cache.set(keyed, freshParse(keyed));

    expect(await cache.get(keyed)).not.toBeNull();
    // The miss is still on the board: the counters are cumulative, not a
    // per-lookup verdict.
    expect(cache.stats).toStrictEqual({ hits: 1, misses: 1, writeFailures: 0 });
  });

  it.each(MISS_ROUTES)('counts $name as a miss', async ({ arrange }) => {
    const { cache, keyed } = await arrange(suite);

    expect(await cache.get(keyed)).toBeNull();
    expect(cache.stats).toStrictEqual({ hits: 0, misses: 1, writeFailures: 0 });
  });

  it('counts per instance, not per process', async () => {
    const keyed = keyedFromText(SIMPLE_DOC);
    await suite.makeCache().set(keyed, freshParse(keyed));

    const reader = suite.makeCache();
    await reader.get(keyed);

    expect(reader.stats).toStrictEqual({ hits: 1, misses: 0, writeFailures: 0 });
    expect(suite.makeCache().stats).toStrictEqual({ hits: 0, misses: 0, writeFailures: 0 });
  });
});

describe('parseKeyed', () => {
  const suite = setupParseCacheTestSuite();

  it('parses on a cold cache and records the miss', async () => {
    const keyed = keyedFromText(SIMPLE_DOC);
    const cache = suite.makeCache();

    const result = await parseKeyed(keyed, cache);

    expect(result).toStrictEqual(freshParse(keyed));
    expect(cache.stats).toStrictEqual({ hits: 0, misses: 1, writeFailures: 0 });
  });

  it('serves the second call from the entry the first one filed', async () => {
    const keyed = keyedFromText(SIMPLE_DOC);
    const cache = suite.makeCache();

    const cold = await parseKeyed(keyed, cache);
    const warm = await parseKeyed(keyed, cache);

    expect(warm).toStrictEqual(cold);
    // Without this line the assertion above holds under an always-miss cache.
    expect(cache.stats).toStrictEqual({ hits: 1, misses: 1, writeFailures: 0 });
  });

  it('round-trips exotic frontmatter through a warm lookup', async () => {
    const keyed = keyedFromText(EXOTIC_FRONTMATTER_DOC);
    const cache = suite.makeCache();

    const cold = await parseKeyed(keyed, cache);
    const warm = await parseKeyed(keyed, cache);

    expect(cache.stats).toStrictEqual({ hits: 1, misses: 1, writeFailures: 0 });
    expect(warm.frontmatter?.['inf']).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isNaN(warm.frontmatter?.['nan'])).toBe(true);
    expect(Buffer.isBuffer(warm.frontmatter?.['bin'])).toBe(true);
    expect(warm.links).toStrictEqual(cold.links);
  });

  it('chooses the parser from keyed.parserKind, on identical bytes', async () => {
    const asMarkdown = keyedFromText(DUAL_PARSER_DOC, 'markdown');
    const asHtml = keyedFromText(DUAL_PARSER_DOC, 'html');
    const cache = suite.makeCache();

    const markdownResult = await parseKeyed(asMarkdown, cache);
    const htmlResult = await parseKeyed(asHtml, cache);

    expect(markdownResult).toStrictEqual(
      parseMarkdownContent(asMarkdown.content, asMarkdown.byteLength),
    );
    expect(htmlResult).toStrictEqual(parseHtmlContent(asHtml.content, asHtml.byteLength));
    // Same bytes, different kind — so different keys, and neither read the
    // other's entry.
    expect(cache.stats).toStrictEqual({ hits: 0, misses: 2, writeFailures: 0 });
  });

  it('keeps the two kinds in separate entries across a warm run', async () => {
    const asMarkdown = keyedFromText(DUAL_PARSER_DOC, 'markdown');
    const asHtml = keyedFromText(DUAL_PARSER_DOC, 'html');
    const cache = suite.makeCache();
    await parseKeyed(asMarkdown, cache);
    await parseKeyed(asHtml, cache);

    const warmMarkdown = await parseKeyed(asMarkdown, cache);
    const warmHtml = await parseKeyed(asHtml, cache);

    expect(cache.stats).toStrictEqual({ hits: 2, misses: 2, writeFailures: 0 });
    expect(hrefsOf(warmMarkdown)).toContain(MARKDOWN_ONLY_HREF);
    expect(hrefsOf(warmHtml)).toContain(HTML_ONLY_HREF);
    expect(hrefsOf(warmMarkdown)).not.toContain(HTML_ONLY_HREF);
  });

  it('never lets one hit alias the next (skill-packager mutates links in place)', async () => {
    const keyed = keyedFromText(SIMPLE_DOC);
    const cache = suite.makeCache();
    await parseKeyed(keyed, cache);

    const firstHit = await parseKeyed(keyed, cache);
    const [firstLink] = firstHit.links;
    // Throw rather than skip: a fixture with no links would make this test pass
    // vacuously, which is the failure mode it exists to rule out.
    if (firstLink === undefined) throw new Error('SIMPLE_DOC produced no links to mutate');
    firstLink.resolvedId = 'mutated-downstream';
    const secondHit = await parseKeyed(keyed, cache);

    // Both reads really were hits — a miss would re-parse and hide the aliasing.
    expect(cache.stats).toStrictEqual({ hits: 2, misses: 1, writeFailures: 0 });
    expect(secondHit.links[0]?.resolvedId).toBeUndefined();
    expect(secondHit.links).not.toBe(firstHit.links);
    expect(secondHit.links[0]).not.toBe(firstHit.links[0]);
  });

  it('parses every call when the cache is disabled, counting each as a miss', async () => {
    const keyed = keyedFromText(SIMPLE_DOC);
    const cache = suite.makeCache({ enabled: false });

    const first = await parseKeyed(keyed, cache);
    const second = await parseKeyed(keyed, cache);

    expect(second).toStrictEqual(first);
    expect(second).not.toBe(first);
    expect(cache.stats).toStrictEqual({ hits: 0, misses: 2, writeFailures: 0 });
  });
});

describe('defaultParseCache', () => {
  it('hands back one shared instance, created lazily', () => {
    expect(defaultParseCache()).toBe(defaultParseCache());
  });
});
