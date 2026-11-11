/**
 * A broken INSTALL must not be recorded as a corpus that had nothing to say.
 *
 * `parseOrNull` answers `null` for any throw, and the loop then skips the
 * document — deliberate, because this oracle crawls a real tree and one
 * unparseable file must not abandon the whole snapshot. Once the parsers started
 * arriving by `import()`, that same swallow absorbed the LOADER's failures too,
 * and a `chmod 000` on the built parser produced a well-formed snapshot with
 * `rows: []`: a measurement that did not run, reported as a measurement whose
 * answer was nothing. This snapshot is the parse cache's correctness oracle, so
 * an empty one is not a small lie — it is a green gate over an unrun check.
 *
 * ## Why the fix is a type and not a hoist, and not an inspection either
 *
 * Node's ESM loader reads the module through `fs`, so an unloadable parser
 * throws the same `EACCES` an unreadable *document* throws — nothing in the
 * error tells the two apart, which is why a blocklist of loader codes was tried
 * and deleted.
 *
 * Loading every kind the corpus routes to, above the loop, was tried too and is
 * what this suite used to drive. It works and it costs too much: the parse
 * worker imports its parser on first use precisely so a run that parses nothing
 * loads nothing. So the load stays lazy and `parseOrNull` rethrows one TYPE —
 * `ParserUnavailableError`, matched by `isParserUnavailable`, complete by
 * construction because VAT mints it at its only parser-import boundary
 * (`parser-loader.ts`) and the worker sends its code back over the wire.
 *
 * ## Why both directions are pinned
 *
 * A suite that only proved propagation would pass just as well against a
 * `parseOrNull` that rethrew everything — which would abandon a whole snapshot on
 * one bad document, the failure the swallow exists to prevent. The ordinary
 * parse-failure case below is that negative control.
 */

import type * as ResourcesModule from '@vibe-agent-toolkit/resources';
import { ParseLimitError, ParserUnavailableError } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { captureParseFactSnapshot } from '../../src/pipeline-oracles/parse-fact-snapshot.js';

import { setupCorpusFixture } from './helpers/corpus-fixture.js';

/**
 * What the next dispatcher parse throws, or nothing.
 *
 * `vi.hoisted` because the mock factory below is hoisted above every import and
 * would otherwise close over an uninitialised binding. The parse failure is
 * armed by CONTENT substring (a dispatcher is handed bytes, never a path):
 * failing every document could not distinguish "the loop kept going and each
 * file was skipped" from "the loop stopped".
 */
const failures = vi.hoisted(() => ({
  load: undefined as Error | undefined,
  htmlLoad: undefined as Error | undefined,
  markdownFor: undefined as MarkdownArm,
}));

/** A markdown-parse failure armed for every document containing `contentContains`. */
type MarkdownArm = { contentContains: string; error: Error } | undefined;

// Only the run's dispatcher is wrapped — the seam a failed parser load throws
// THROUGH on this lane. The content-key machinery, `parserKindForPath`, the real
// dispatcher and the real `isParserUnavailable` stay live via `importOriginal`,
// so the rows this oracle produces are the real ones and the predicate under
// test is the shipped one. The html arm is separate from the markdown one
// because an `.html`-only corpus is the case that proves the guard is not
// markdown-shaped.
vi.mock('@vibe-agent-toolkit/resources', async (importOriginal) => {
  const actual = await importOriginal<typeof ResourcesModule>();
  const armed = (keyed: ResourcesModule.ParsableContent): Error | undefined => {
    if (keyed.parserKind === 'html') return failures.htmlLoad;
    if (failures.load) return failures.load;
    return failures.markdownFor && keyed.content.includes(failures.markdownFor.contentContains)
      ? failures.markdownFor.error
      : undefined;
  };
  const withParseDispatcher: typeof actual.withParseDispatcher = (work, options) =>
    actual.withParseDispatcher(
      (dispatcher) =>
        work(
          Object.assign(Object.create(dispatcher) as ResourcesModule.ParseDispatcher, {
            parse: (keyed: ResourcesModule.ParsableContent) => {
              const error = armed(keyed);
              return error === undefined ? dispatcher.parse(keyed) : Promise.reject(error);
            },
          }),
        ),
      options,
    );
  return { ...actual, withParseDispatcher };
});

/**
 * Two markdown documents and one HTML one.
 *
 * Two markdown files because the defect is per-document, so a one-file corpus
 * could not tell an abort apart from a single skip. The HTML file is not
 * decoration: the loop routes by `parserKindForPath`, so it is what keeps the
 * mixed-kind path exercised — and the `.html`-ONLY cases below, which use it
 * alone, are what prove the guard covers the kind a markdown-shaped one would
 * miss entirely.
 */
const CORPUS = {
  'good-a.md': '# A\n\n[b](./bad-b.md)\n',
  'bad-b.md': '# B\n\nNothing links out of here.\n',
  'page.html': '<html><body><h1>Page</h1><a href="./good-a.md">a</a></body></html>\n',
};

const fixture = setupCorpusFixture('vat-parse-fact-load-', CORPUS);

// Registered AFTER the fixture's own hook, and vitest runs `beforeEach` in
// registration order — irrelevant today because these two touch nothing in
// common, and stated so that a future arming step which needs the corpus on
// disk knows it is already there.
beforeEach(() => {
  failures.load = undefined;
  failures.htmlLoad = undefined;
  failures.markdownFor = undefined;
});

/**
 * The failure the reproduction actually produced, as it arrives at a parse call:
 * `chmod 000` on the built parser, surfacing as the ESM loader's own `fs` read
 * failing, wrapped at VAT's import boundary.
 *
 * Built from the REAL exported class rather than hand-rolled, so a change to
 * what `isParserUnavailable` accepts cannot pass here by agreeing with a
 * fixture's idea of the type. The `EACCES` underneath is precisely the error an
 * inspection-based guard could never tell apart from an unreadable document.
 *
 * ⚠️ `DocumentParserKind`, not `ParserKind`. Only the two kinds a parser MODULE
 * exists for can fail to load one; `none` names the absence of a parser, so it
 * has no module and cannot reach this error at all.
 *
 * @param kind - Which parser module failed to load
 * @returns A fresh error per test, so identity assertions are meaningful
 */
function parserLoadFailure(kind: ResourcesModule.DocumentParserKind = 'markdown'): Error {
  return new ParserUnavailableError(
    kind,
    kind === 'html' ? './html-link-parser.js' : './link-parser.js',
    Object.assign(new Error("permission denied, open '.../dist/link-parser.js'"), { code: 'EACCES' }),
  );
}

/**
 * Capture the fixture corpus.
 *
 * @returns The snapshot for all three fixture documents
 */
async function capture(): Promise<Awaited<ReturnType<typeof captureParseFactSnapshot>>> {
  return captureParseFactSnapshot(fixture.absolutePaths(), {
    corpusRoot: fixture.root(),
    corpus: 'parser-load-fixture',
  });
}

/**
 * Capture the ONE `.html` fixture document, alone.
 *
 * Alone is the whole point: a corpus of one `.html` file never calls the
 * markdown wrapper, so this is the only shape that can reach the html branch of
 * `parseOrNull` — which is what makes the guard provably not markdown-shaped.
 *
 * @returns The snapshot for `page.html` and nothing else
 */
async function captureHtmlOnly(): Promise<Awaited<ReturnType<typeof captureParseFactSnapshot>>> {
  const corpusRoot = fixture.root();
  return captureParseFactSnapshot([safePath.join(corpusRoot, 'page.html')], {
    corpusRoot,
    corpus: 'html-only-fixture',
  });
}

describe('a parser-load failure during parse-fact capture', () => {
  it('propagates instead of yielding an empty snapshot', async () => {
    const thrown = parserLoadFailure();
    failures.load = thrown;

    // Identity, not `toThrow(message)`: what must survive is the loader's own
    // error object, because the caller's top-level handler prints its code.
    //
    // Under the defect this did not reject at all — it RESOLVED, with every
    // document skipped and `rows: []`, and the gate downstream read that as a
    // corpus whose parse facts were empty.
    await expect(capture()).rejects.toBe(thrown);
  });

  it('propagates from an `.html`-only corpus too', async () => {
    // The kind-specific hole. The markdown case above passes for a lane that
    // only ever guards `parseMarkdown` — and the helper this replaced derived
    // its kinds from the paths for exactly this reason, with nothing driving an
    // html path. A corpus of one `.html` file never calls the markdown wrapper
    // at all, so this is the only case that can see the html branch.
    const thrown = parserLoadFailure('html');
    failures.htmlLoad = thrown;

    await expect(captureHtmlOnly()).rejects.toBe(thrown);
  });

  it('captures an `.html`-only corpus when the load succeeds', async () => {
    // The positive control for the case above: without it, a `rejects` that held
    // because the one-file corpus produced no rows for some unrelated reason
    // would look identical.
    const snapshot = await captureHtmlOnly();

    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0]?.parserKind).toBe('html');
  });
});

/**
 * The discriminator. Without it, a `parseOrNull` that rethrew unconditionally
 * would satisfy every assertion above — and would abandon the whole snapshot on
 * one unparseable document, which is what the swallow exists to prevent.
 */
describe('an ordinary parse failure during parse-fact capture', () => {
  it('skips only the failing document and captures the rest', async () => {
    // A failure on `classifyParseFailure`'s allowlist — a document refused for
    // this run at a limit. An unbranded `Error` is VAT's defect and is rethrown.
    failures.markdownFor = { contentContains: 'Nothing links out of here', error: new ParseLimitError('timeMs', 10) };

    const snapshot = await capture();

    // The other markdown document and the HTML one are both still recorded, so
    // the loop walked past the failure rather than stopping at it.
    expect(snapshot.rows).toHaveLength(Object.keys(CORPUS).length - 1);
    // Every path is still accounted for in `pathsByKey` — that map is written
    // from the read, before the parse, so a skipped document stays visible as a
    // document the capture saw.
    expect(Object.keys(snapshot.pathsByKey)).toHaveLength(Object.keys(CORPUS).length);
  });

  it('captures every document when nothing fails', async () => {
    const snapshot = await capture();

    // The baseline the two cases above are read against: with no failure armed
    // the fixture is fully capturable, so neither row count is an artifact of
    // the fixture itself.
    expect(snapshot.rows).toHaveLength(Object.keys(CORPUS).length);
  });
});
