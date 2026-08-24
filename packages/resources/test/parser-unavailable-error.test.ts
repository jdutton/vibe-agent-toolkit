/**
 * A failed parser load must be structurally distinguishable from a filesystem
 * error, at the point where it originates.
 *
 * ## Why hoisting the load out of the per-document `try` was necessary but not
 * sufficient
 *
 * Six call sites now await `loadParser` OUTSIDE their per-document `try`, so a
 * loader failure is no longer recorded once per innocent document. It still
 * exited 0. Node's ESM loader reads the module through `fs`, so a `chmod 000` on
 * the built `link-parser.js` throws a raw `EACCES` — and `vat audit`'s outer scan
 * boundary degrades ANY error satisfying `isFilesystemAccessError` into a
 * `SCAN_PATH_UNREADABLE` finding at severity `warning`. Reproduced: `chmod 000
 * packages/resources/dist/link-parser.js` with `VAT_CACHE=0`, `vat audit` exits 0.
 *
 * Hoisting further is chasing an unbounded chain — every outer boundary that
 * allow-lists filesystem errnos re-swallows it. So the fix is at the origin: the
 * loader's failure is rethrown wearing a code no errno allow-list contains.
 *
 * ## What these tests are evidence OF
 *
 * The load-bearing assertion is the one about the predicate, not the one about
 * the class. `isFilesystemAccessError` returning `false` for the wrapper is only
 * evidence when the SAME test shows it returning `true` for a plain `EACCES` —
 * otherwise a predicate broken into always returning `false` would satisfy it
 * just as well.
 *
 * That pairing is also what caught the design's one real trap: the predicate
 * WALKS the `cause` chain (deliberately — the CLI config loader re-wraps read
 * failures). So an original `EACCES` reachable via `cause` is found by that walk
 * and the wrapper is degraded anyway. Setting `cause` silently cancels the whole
 * fix, which is why the original hangs off `loaderError` instead.
 *
 * ## Why the seam is driven with a throwing accessor
 *
 * The failure is injected by making the mocked module's `parseMarkdownContent`
 * export throw when read — the read that `importParser`'s
 * `const { parseMarkdownContent } = await import(...)` performs, inside the very
 * `try` under test. A factory that throws outright was tried first and is not
 * usable: vitest replaces the thrown value with its own "error when mocking a
 * module" wrapper, so the test could no longer assert on the loader's real error
 * object, and a successfully-evaluated mock is cached past `vi.resetModules()`,
 * making the evaluation counter order-dependent. The accessor is re-entered on
 * every read, so both the error identity and the attempt count are exact.
 */

import { isFilesystemAccessError } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ParseCacheModule from '../src/parse-cache.js';

/**
 * Whether the mocked markdown parser fails to load, and how many times a load
 * has been attempted.
 *
 * `vi.hoisted` because the factory below is hoisted above every import and would
 * otherwise close over an uninitialised binding. The counter is what makes the
 * eviction test evidence: "the second call resolved" is also true of a memo that
 * had cached a resolved value, but "the module was reached twice" is not.
 */
const loader = vi.hoisted(() => ({
  failure: undefined as Error | undefined,
  htmlFailure: undefined as Error | undefined,
  attempts: 0,
}));

// Mocks the modules `importParser` actually imports, not `loadParser` itself:
// what is under test is the wrapping that happens AT the import, and a stubbed
// `loadParser` would only prove that a stub throws what it was told to. The
// success half returns a stub parser rather than the real one — remark and parse5
// are irrelevant here, and not loading them keeps this a unit test.
vi.mock('../src/link-parser.js', () => ({
  get parseMarkdownContent() {
    loader.attempts += 1;
    if (loader.failure) throw loader.failure;
    return () => ({ links: [], headings: [], estimatedTokenCount: 0 });
  },
}));

// Both kinds are mocked because the message's module name comes from a lookup
// table rather than from the `import()` call itself, so only exercising markdown
// would let the html entry drift into naming a module the loader never touched.
vi.mock('../src/html-link-parser.js', () => ({
  get parseHtmlContent() {
    if (loader.htmlFailure) throw loader.htmlFailure;
    return () => ({ links: [], headings: [], estimatedTokenCount: 0 });
  },
}));

/**
 * The failure the reproduction actually produced: the loader's own `fs` read
 * being refused.
 *
 * `EACCES` is deliberate rather than a loader-specific code — it is a member of
 * both `FILESYSTEM_ACCESS_ERRNOS` and `resource-registry`'s `READ_FAILURE_CODES`,
 * so it is precisely the error an inspection-based guard cannot tell apart from
 * an unreadable document.
 *
 * @returns A fresh error per test, so identity assertions mean something
 */
function loaderEacces(): Error & { code: string } {
  return Object.assign(
    new Error("EACCES: permission denied, open '/x/packages/resources/dist/link-parser.js'"),
    { code: 'EACCES' },
  );
}

/**
 * A parse-cache module with an EMPTY parser memo.
 *
 * `parserLoads` is module-level state, so a suite sharing one instance would let
 * an earlier test's successful load answer a later test's failure case. Each test
 * gets its own instance — and therefore its own `ParserUnavailableError` class
 * identity, which is why every `instanceof` below is taken against the class from
 * the SAME returned module.
 *
 * @returns A freshly evaluated `parse-cache.js`
 */
async function freshParseCache(): Promise<typeof ParseCacheModule> {
  vi.resetModules();
  return import('../src/parse-cache.js');
}

/**
 * Drive a load that is expected to fail, and hand back what it threw.
 *
 * `.catch` rather than `expect().rejects`, because most assertions below are
 * about the thrown VALUE — its code, its `loaderError`, how a predicate
 * classifies it — and `rejects` matchers cannot express those together.
 *
 * @param mod - The parse-cache instance to drive
 * @param kind - Which parser to ask for
 * @returns The thrown value, or `undefined` if the load unexpectedly succeeded
 */
async function loadFailure(
  mod: typeof ParseCacheModule,
  kind: 'markdown' | 'html' = 'markdown',
): Promise<unknown> {
  return mod.loadParser(kind).then(
    () => undefined,
    (error: unknown) => error,
  );
}

beforeEach(() => {
  loader.failure = undefined;
  loader.htmlFailure = undefined;
  loader.attempts = 0;
});

afterEach(() => {
  loader.failure = undefined;
  loader.htmlFailure = undefined;
});

describe('a parser module that cannot be loaded', () => {
  it('surfaces as ParserUnavailableError, not as the raw errno', async () => {
    loader.failure = loaderEacces();
    const mod = await freshParseCache();

    const thrown = await loadFailure(mod);

    expect(thrown).toBeInstanceOf(mod.ParserUnavailableError);
    expect((thrown as { code: unknown }).code).toBe('VAT_PARSER_UNAVAILABLE');
    // Explicit, because passing the original code through is the exact
    // "helpful" regression this wrapper exists to prevent.
    expect((thrown as { code: unknown }).code).not.toBe('EACCES');
  });

  it('preserves the loader error verbatim for debugging', async () => {
    const original = loaderEacces();
    loader.failure = original;
    const mod = await freshParseCache();

    const thrown = (await loadFailure(mod)) as ParseCacheModule.ParserUnavailableError;

    // Identity, not a message match: an operator debugging a broken install
    // needs the loader's own stack, and `util.inspect` prints own enumerable
    // properties of an Error, so this surfaces in an uncaught-exception dump.
    expect(thrown.loaderError).toBe(original);
  });

  it('does not expose the loader error on `cause`, which the predicate walks', async () => {
    loader.failure = loaderEacces();
    const mod = await freshParseCache();

    const thrown = (await loadFailure(mod)) as ParseCacheModule.ParserUnavailableError;

    // Pinned deliberately, and NOT a stylistic preference: `isFilesystemAccessError`
    // follows `cause`, so an original `EACCES` placed there is found by that walk
    // and the error is degraded to a warning again. The test below would go red
    // the moment someone "restores" it, but this one names the reason.
    expect(thrown.cause).toBeUndefined();
  });

  it('names the parser module and blames the installation, not a document', async () => {
    loader.failure = loaderEacces();
    const mod = await freshParseCache();

    const message = ((await loadFailure(mod)) as Error).message;

    expect(message).toContain('./link-parser.js');
    // Says the INSTALL is broken, and says so about the install rather than
    // about whatever file the crawl happened to be holding.
    expect(message).toContain('broken VAT installation');
    expect(message).toContain('No document being scanned is at fault');
    // The actionable detail rides in the TEXT even though it must never ride on
    // `.code`.
    expect(message).toContain('EACCES');
    expect(message).toContain('permission denied');
  });

  it('names the html parser module when the html load is the one that fails', async () => {
    loader.htmlFailure = loaderEacces();
    const mod = await freshParseCache();

    const message = ((await loadFailure(mod, 'html')) as Error).message;

    expect(message).toContain('./html-link-parser.js');
    // The markdown specifier must not leak into the html branch — which is the
    // drift the shared lookup table makes possible.
    expect(message).not.toContain('(./link-parser.js)');
  });

  it('is not classified as a filesystem access error by the outer boundaries', async () => {
    const original = loaderEacces();
    loader.failure = original;
    const mod = await freshParseCache();

    const thrown = await loadFailure(mod);

    // THE assertion. `vat audit`'s scan catch degrades anything this predicate
    // accepts into a `warning` and exits 0 — which is how a broken install kept
    // reporting success.
    expect(isFilesystemAccessError(thrown)).toBe(false);
    // The positive control, in the same test: without it the assertion above is
    // satisfied by a predicate that accepts nothing at all, and proves nothing
    // about THIS error.
    expect(isFilesystemAccessError(original)).toBe(true);
  });

  it('evicts the rejected load so a transient failure stays retryable', async () => {
    loader.failure = loaderEacces();
    const mod = await freshParseCache();

    await expect(mod.loadParser('markdown')).rejects.toBeInstanceOf(mod.ParserUnavailableError);
    expect(loader.attempts).toBe(1);

    // `mod` is the instance captured above, so its `parserLoads` memo is the one
    // under test — a memo that had retained the rejection would replay it here
    // without ever reaching the module again.
    loader.failure = undefined;

    await expect(mod.loadParser('markdown')).resolves.toMatchObject({
      parseContent: expect.any(Function) as unknown,
    });
    expect(loader.attempts).toBe(2);
  });

  it('memoizes a successful load, so the module is reached once', async () => {
    const mod = await freshParseCache();

    const first = await mod.loadParser('markdown');
    const second = await mod.loadParser('markdown');

    // The negative control for the eviction test above: without it, a `loadParser`
    // that had simply stopped memoizing would satisfy every assertion there while
    // paying the ~730 ms module load on every document.
    expect(second).toBe(first);
    expect(loader.attempts).toBe(1);
  });
});
