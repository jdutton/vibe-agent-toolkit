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
 * ## Why the fix is a seam and not a predicate
 *
 * Node's ESM loader reads the module through `fs`, so an unloadable parser
 * throws the same `EACCES` an unreadable *document* throws — nothing in the
 * error tells the two apart. So `loadParser` is awaited OUTSIDE the loop, for
 * every kind the corpus routes to, and `parseOrNull`'s catch can no longer see a
 * loader failure at all.
 *
 * ## Why both directions are pinned
 *
 * A suite that only proved propagation would pass just as well against a
 * `parseOrNull` that rethrew everything — which would abandon a whole snapshot on
 * one bad document, the failure the swallow exists to prevent. The ordinary
 * parse-failure case below is that negative control.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import type * as ResourcesModule from '@vibe-agent-toolkit/resources';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureParseFactSnapshot } from '../../src/pipeline-oracles/parse-fact-snapshot.js';

/**
 * What the next `loadParser` / `parseMarkdown` call throws, or nothing.
 *
 * `vi.hoisted` because the mock factory below is hoisted above every import and
 * would otherwise close over an uninitialised binding. The parse failure is
 * armed by path SUBSTRING: failing every document could not distinguish "the
 * loop kept going and each file was skipped" from "the loop stopped".
 */
const failures = vi.hoisted(() => ({ load: undefined as Error | undefined, markdownFor: undefined as MarkdownArm }));

/** A markdown-parse failure armed for every path containing `pathContains`. */
type MarkdownArm = { pathContains: string; error: Error } | undefined;

// The load and the markdown parse are the only things replaced. The content-key
// machinery, `parserKindForPath` and the real HTML parser stay live via
// `importOriginal`, so the rows this oracle produces are the real ones.
vi.mock('@vibe-agent-toolkit/resources', async (importOriginal) => {
  const actual = await importOriginal<typeof ResourcesModule>();
  const parseMarkdown = async (absolutePath: string) =>
    failures.markdownFor && absolutePath.includes(failures.markdownFor.pathContains)
      ? Promise.reject(failures.markdownFor.error)
      : actual.parseMarkdown(absolutePath);
  const loadParser = async (kind: ResourcesModule.ParserKind) =>
    failures.load ? Promise.reject(failures.load) : actual.loadParser(kind);
  return { ...actual, parseMarkdown, loadParser };
});

/**
 * Two markdown documents and one HTML one.
 *
 * Two markdown files because the defect is per-document, so a one-file corpus
 * could not tell an abort apart from a single skip. The HTML file is not
 * decoration: the loop routes by `parserKindForPath`, so it is what proves the
 * hoisted load covers every kind the corpus will actually ask for rather than
 * assuming markdown.
 */
const CORPUS = {
  'good-a.md': '# A\n\n[b](./bad-b.md)\n',
  'bad-b.md': '# B\n\nNothing links out of here.\n',
  'page.html': '<html><body><h1>Page</h1><a href="./good-a.md">a</a></body></html>\n',
};

let corpusRoot: string;

beforeEach(() => {
  failures.load = undefined;
  failures.markdownFor = undefined;
  corpusRoot = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-parse-fact-load-'));
  for (const [name, content] of Object.entries(CORPUS)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a fixture name from CORPUS, under this test's own mkdtemp root
    writeFileSync(safePath.join(corpusRoot, name), content, 'utf8');
  }
});

afterEach(() => {
  rmSync(corpusRoot, { recursive: true, force: true });
});

/**
 * The failure the reproduction actually produced: `chmod 000` on the built
 * parser, surfacing as the ESM loader's own `fs` read failing.
 *
 * `EACCES` is deliberate rather than a loader-specific code — it is precisely
 * the error an inspection-based guard could never tell apart from an unreadable
 * document.
 *
 * @returns A fresh error per test, so identity assertions are meaningful
 */
function parserLoadFailure(): Error {
  return Object.assign(new Error("permission denied, open '.../dist/link-parser.js'"), { code: 'EACCES' });
}

/**
 * Capture the fixture corpus.
 *
 * @returns The snapshot for all three fixture documents
 */
async function capture(): Promise<Awaited<ReturnType<typeof captureParseFactSnapshot>>> {
  const absolutePaths = Object.keys(CORPUS).map((name) => safePath.join(corpusRoot, name));
  return captureParseFactSnapshot(absolutePaths, { corpusRoot, corpus: 'parser-load-fixture' });
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
});

/**
 * The discriminator. Without it, a `parseOrNull` that rethrew unconditionally
 * would satisfy every assertion above — and would abandon the whole snapshot on
 * one unparseable document, which is what the swallow exists to prevent.
 */
describe('an ordinary parse failure during parse-fact capture', () => {
  it('skips only the failing document and captures the rest', async () => {
    failures.markdownFor = { pathContains: 'bad-b', error: new Error('unexpected token') };

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
