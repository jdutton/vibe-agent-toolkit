/**
 * A broken INSTALL must not be reported as a broken DOCUMENT.
 *
 * The parser arrives by `import()`, so a module that cannot be loaded — a
 * half-extracted tarball, a quarantined or `chmod 000` file — is a failure that
 * happens at the moment of parsing. Both of this package's parse sites sit
 * inside a per-document `try` for a real and different reason: every keyed blob
 * is derived, including `.mjs` and `.txt`, and every enumerated file is
 * admitted, so the parser is handed arbitrary bytes by design and one document
 * failing must not abort a whole run.
 *
 * Which made the two classes collide. Unguarded, a `chmod 000` on the built
 * `link-parser.js` produced 8 × `RESOURCE_UNREADABLE` with `filesScanned: 0` —
 * every innocent markdown file blamed in turn for one unreadable module.
 *
 * ## Why the fix is a type and not a hoist, and not an inspection either
 *
 * The classes are NOT distinguishable by inspecting the error: Node's ESM loader
 * reads the module through `fs`, so an unloadable parser throws the same
 * `EACCES`/`ENOENT` an unreadable *document* throws, and a module that throws
 * while EVALUATING carries no loader code at all. A blocklist of loader codes
 * was tried and deleted; a test fabricating a coded error out of the parse would
 * only ever have proven that such a blocklist matched its own members.
 *
 * Awaiting `loadParser` above each `try` was tried too, and it is what these
 * tests used to drive. It works and it costs too much: the load happens inside
 * `parseKeyed`, past the cache's hit-path return, precisely so a fully warm run
 * loads no parser at all (measured: 1,049 scripts warm against 1,235 cold). Any
 * hoist cancels that silently.
 *
 * So the load stays lazy and the catch rethrows one TYPE —
 * `ParserUnavailableError`, constructed at VAT's single parser-import boundary,
 * matched by `isParserUnavailable`. Complete by construction rather than by
 * enumeration: there is no parser-load failure that does not pass through that
 * one wrap.
 *
 * ## What these tests drive, and what they do not
 *
 * They inject a genuine `ParserUnavailableError` at the parse seam, which is
 * exactly what the lazy load produces there. That the real import boundary
 * really MINTS that error — for both parser kinds, and through both routes into
 * the parser modules — is `parser-unavailable-error.test.ts`'s job, driven
 * against the real `import()` with a fresh module instance per case. Splitting
 * it that way keeps this suite's subject the attribution decision, which is the
 * thing that regressed.
 *
 * ## Why both directions are pinned
 *
 * A suite that only proves propagation would pass just as well against a catch
 * that rethrows *everything* — which would resurrect the aborted-run bug the
 * catch exists to prevent. So the ordinary-parser-error cases below are not
 * padding: they are the negative control that makes the propagation evidence of
 * a DISCRIMINATION rather than of a blanket.
 *
 * ## Why it drives the real stages
 *
 * `loadParser` in isolation would prove the class and miss the mechanism — the
 * thing that regressed is the route from a failed load to who gets blamed, and
 * a seam test stays green if the call is moved back inside the try. The
 * projection builder is driven by hand rather than through `populate()` because
 * the propagation's whole point is that the run does not complete: after a
 * rejection there is no projection to inspect, and the builder is the only place
 * the rows the stage did-or-did-not record can still be read.
 */

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ParseCacheModule from '../src/parse-cache.js';
import { ParseCache, ParserUnavailableError } from '../src/parse-cache.js';
import { BLOB_PARSE_FAILED, populateBlobs } from '../src/projection/blob-population.js';
import { ResourceRegistry } from '../src/resource-registry.js';

import { baseBuilderForRoot, conditionsWithCode } from './blob-fixture-population.js';
import { setupSubdirTestSuite, useCorpusSuite, type CorpusFile } from './test-helpers.js';

/**
 * What the next `parseKeyed` call throws, or nothing.
 *
 * `vi.hoisted` because the mock factory below is hoisted above every import and
 * would otherwise close over an uninitialised binding. One field per class,
 * because the whole subject is which of the two the catch may swallow.
 */
const failures = vi.hoisted(() => ({
  load: undefined as Error | undefined,
  parse: undefined as Error | undefined,
}));

// Only `parseKeyed` is replaced — the seam the lazy parser load throws THROUGH.
// Everything else — `ParseCache`, `isParserUnavailable`, the content-key
// machinery the base stratum runs — stays real via `importOriginal`, so the
// realizations these tests derive blobs from are the ones a real crawl produces
// and the predicate under test is the shipped one. Mocking the whole module
// would make the fixture's keys fictional and the stages under test would never
// be reached with a genuine target. `ResourceRegistry` imports from this same
// module, so one mock covers both call sites.
vi.mock('../src/parse-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ParseCacheModule>();
  return {
    ...actual,
    parseKeyed: async (...args: Parameters<typeof actual.parseKeyed>) => {
      if (failures.load) throw failures.load;
      if (failures.parse) throw failures.parse;
      return actual.parseKeyed(...args);
    },
  };
});

/**
 * Two documents, deliberately: the defect being guarded against is "once per
 * document", so a one-file corpus could not tell an abort apart from a single
 * recorded finding. Distinct content, so they are two blobs and not one.
 */
const CORPUS: readonly CorpusFile[] = [
  { path: 'a.md', content: '# A\n\n[b](./b.md)\n' },
  { path: 'b.md', content: '# B\n\nNothing links out of here.\n' },
];

/**
 * A cache that never touches disk.
 *
 * `defaultParseCache()` would reach a shared on-disk cache whose contents are a
 * fact about previous runs, not about these stages. Nothing here should be
 * served from it — and a hit would silently bypass the very failure the suite
 * installs.
 */
const NO_CACHE = new ParseCache({ enabled: false });

const suite = setupSubdirTestSuite('blob-parse-failure-attribution-');
useCorpusSuite(suite, [], CORPUS);

beforeEach(() => {
  failures.load = undefined;
  failures.parse = undefined;
});

afterEach(() => {
  failures.load = undefined;
  failures.parse = undefined;
});

/**
 * An error carrying a `code`, the shape Node's loader and Node's own argument
 * validators both throw.
 *
 * @param code - The `code` property to attach
 * @param message - What the error says
 * @returns The error, ready to be thrown from a mocked seam
 */
function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * The failure the reproduction actually produced, as it arrives at a parse site:
 * `chmod 000` on the built parser, surfacing as the loader's own `fs` read
 * failing, wrapped at VAT's import boundary.
 *
 * The wrapper is built from the REAL exported class rather than hand-rolled, so
 * a change to what `isParserUnavailable` accepts cannot pass here by agreeing
 * with a fixture's idea of the type. The `EACCES` underneath is deliberate: it
 * is a member of `resource-registry`'s READ_FAILURE_CODES, so it is precisely
 * the error an inspection-based guard could never tell apart from an unreadable
 * document — and it must stay reachable only via `loaderError`.
 *
 * @returns A fresh error per test, so identity assertions are meaningful
 */
function parserLoadFailure(): Error {
  return new ParserUnavailableError(
    'markdown',
    './link-parser.js',
    codedError('EACCES', "permission denied, open '.../dist/link-parser.js'"),
  );
}

/**
 * The fixture documents, as the absolute paths a crawl would hand the registry.
 *
 * @returns One absolute path per {@link CORPUS} entry
 */
function corpusPaths(): string[] {
  return CORPUS.map((file) => safePath.join(suite.tempDir, file.path));
}

describe('a parser-load failure during blob derivation', () => {
  it('propagates instead of blaming the document', async () => {
    const thrown = parserLoadFailure();
    failures.load = thrown;
    const builder = await baseBuilderForRoot(suite.tempDir);

    // Identity, not `toThrow(message)`: what must survive is the loader's own
    // error object, because the caller's top-level handler prints its code.
    await expect(populateBlobs(builder, { parseCache: NO_CACHE })).rejects.toBe(thrown);

    const projection = builder.build();
    expect(conditionsWithCode(projection, BLOB_PARSE_FAILED)).toEqual([]);
    // Nothing was derived either: the run aborted at the first blob rather than
    // walking on and accusing the second document as well.
    expect(projection.blobs).toEqual([]);
  });
});

/**
 * The discriminator. Without these, a catch that rethrew unconditionally would
 * satisfy every assertion above — and would abort a whole population on one
 * unparseable file, which is the failure the catch exists to prevent.
 */
describe('an ordinary parser failure during blob derivation', () => {
  const ORDINARY_FAILURES = [
    // No `code` at all: the shape a parser's own `throw new Error(...)` has.
    { label: 'a plain Error with no code', error: new Error('unexpected token') },
    // A `code`, but one that reaches the catch from the parse rather than from
    // the load — proves the catch still swallows a coded error, so the guard is
    // the one constructed type and not a resurrected code check.
    {
      label: 'a coded error thrown by the parse',
      error: codedError('ERR_INVALID_ARG_TYPE', 'The "input" argument must be of type string'),
    },
  ];

  it.each(ORDINARY_FAILURES)('records BLOB_PARSE_FAILED for $label', async ({ error }) => {
    failures.parse = error;
    const builder = await baseBuilderForRoot(suite.tempDir);

    const counts = await populateBlobs(builder, { parseCache: NO_CACHE });

    expect(counts.blobsParseFailed).toBe(CORPUS.length);
    const conditions = conditionsWithCode(builder.build(), BLOB_PARSE_FAILED);
    expect(conditions).toHaveLength(CORPUS.length);
    expect(conditions[0]?.message).toContain('parser threw on the bytes at');
  });
});

/**
 * The same collision one layer over, and the one the reproduction actually ran:
 * `ResourceRegistry.addResources` demotes any READ_FAILURE_CODES error into a
 * per-file `RESOURCE_UNREADABLE`, and the ESM loader's own failures wear exactly
 * those codes.
 */
describe('a parser-load failure during registry admission', () => {
  it('propagates instead of blaming every enumerated file', async () => {
    const thrown = parserLoadFailure();
    failures.load = thrown;
    const registry = new ResourceRegistry();

    await expect(registry.addResources(corpusPaths())).rejects.toBe(thrown);

    // The defect: `EACCES` from the loader landed here once per file, so the
    // command reported a corpus of unreadable documents and still exited on a
    // finding rather than on the broken install.
    expect(registry.getUnreadableResources()).toEqual([]);
  });

  // The negative control. Without it the assertion above would also hold for a
  // registry that had stopped demoting read failures at all — which is the
  // silent-population-shrink bug that demotion exists to prevent.
  it('still demotes a genuinely unreadable document to RESOURCE_UNREADABLE', async () => {
    const registry = new ResourceRegistry();
    const missing = safePath.join(suite.tempDir, 'gone.md');

    const admitted = await registry.addResources([...corpusPaths(), missing]);

    expect(admitted).toHaveLength(CORPUS.length);
    const unreadable = registry.getUnreadableResources();
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]?.code).toBe('ENOENT');
  });
});
