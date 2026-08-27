/**
 * A collection's declared `mimeType` reaching the PARSER, through `populate()`.
 *
 * The resolver is unit-tested next door. What this suite exists for is the
 * wiring between it and everything downstream — the run builds ONE resolver, the
 * extents consult that one, the declaration reaches the content key rather than
 * merely the `mime` column, and a config conflict becomes queryable rows instead
 * of a throw or a silence.
 *
 * ## Why the assertions are about the content KEY, not just the column
 *
 * `mime` is a column on `resource_realizations`; the parser kind is mixed into
 * the content key's digest preimage. A wiring that filled the column and left
 * the keying alone would look completely correct in a row dump and would still
 * mean the declaration changed nothing about what ran. So the key prefix is what
 * is pinned: `markdown.` means a parser ran, `none.` means none did.
 */

import { toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { COLLECTION_MIME_CONFLICT } from '../src/index.js';
import { ContributorRegistry } from '../src/projection/contributor.js';
import { FilesystemExtentContributor } from '../src/projection/contributors/filesystem-extent.js';
import { crawlSourceFor } from '../src/projection/crawl-source.js';
import { DISCARD_BLOB_POPULATION, populate } from '../src/projection/merge.js';
import type { Projection } from '../src/projection/projection.js';
import type { CollectionConfig } from '../src/schemas/project-config.js';

import { setupTempCorpus } from './helpers/temp-corpus.js';

/**
 * One `.ts` file carrying a markdown link, and one `.md` control.
 *
 * ⚠️ NOT byte-identical, and that is load-bearing: blobs are content-addressed
 * and the parser kind is the only path-derived input to the key, so twins with
 * identical bytes would collapse into ONE blob the moment a declaration routed
 * them to the same parser — and every assertion below would then be about
 * whichever path happened to sort first.
 */
const CORPUS = {
  'notes.md': '# Notes\n\nThe control: [target](./notes.md) in real prose.\n',
  'strings.ts': '// marker: strings\nexport const s = "[target](./notes.md)";\n',
};

/** The glob every declaration in this suite is written over. */
const TS_GLOB = '**/*.ts';

/** The type a declaration uses to pull a `.ts` onto the markdown parser. */
const AS_PROSE = 'text/markdown';

/** The rival type in the conflicting pair — anything but {@link AS_PROSE}. */
const AS_DATA = 'application/json';

/** The fixture whose routing the declarations change. */
const SUBJECT = 'strings.ts';

const fixture = setupTempCorpus('vat-mime-routing-', CORPUS);

/**
 * Populate the fixture under the given declarations.
 *
 * Runs the REAL `populate()` with the real filesystem extent, so what is
 * exercised is the shipped path from `PopulateOptions.collections` through the
 * builder and the extent to `collectRealization` — not a hand-assembled base
 * that would restate the wiring under test.
 *
 * @param collections - The project's collections, or undefined to declare none
 * @returns The populated projection
 */
async function populateWith(
  collections: Readonly<Record<string, CollectionConfig>> | undefined,
): Promise<Projection> {
  const registry = new ContributorRegistry();
  registry.register(new FilesystemExtentContributor(() => crawlSourceFor(fixture.root())));

  return populate({
    root: fixture.root(),
    registry,
    onBlobPopulation: DISCARD_BLOB_POPULATION,
    ...(collections !== undefined && { collections }),
  });
}

/**
 * The realization row for one fixture file.
 *
 * @param projection - The populated projection
 * @param name - The fixture's root-relative name
 * @returns The first realization at that path
 */
function rowFor(projection: Projection, name: string) {
  return projection.resourceRealizations.find((row) => toForwardSlash(row.path) === name);
}

describe('a collection that declares a mimeType', () => {
  it('routes a .ts file to the markdown parser, key and column together', async () => {
    const projection = await populateWith({
      sources: { include: [TS_GLOB], mimeType: AS_PROSE },
    });
    const row = rowFor(projection, SUBJECT);

    // The column is the visible half; the KEY is the half that says a parser
    // actually ran. Both, or the declaration reached the row and not the parse.
    expect(row?.mime).toBe(AS_PROSE);
    expect(row?.contentKey).toMatch(/^markdown\./);
  });

  it('leaves that same file unparsed when nothing declares a type', async () => {
    // The control the test above is read against. Without it, a `markdown.`
    // prefix could just as well mean the MIME routing never shipped.
    const row = rowFor(await populateWith(undefined), SUBJECT);

    expect(row?.mime).toBe('text/x-typescript');
    expect(row?.contentKey).toMatch(/^none\./);
  });

  it('does not disturb a file it does not match', async () => {
    // Scoping, stated as a fact rather than assumed: a declaration over `**/*.ts`
    // must not re-type the prose file next to it.
    const projection = await populateWith({
      sources: { include: [TS_GLOB], mimeType: 'text/plain' },
    });

    expect(rowFor(projection, 'notes.md')?.mime).toBe(AS_PROSE);
    expect(rowFor(projection, 'notes.md')?.contentKey).toMatch(/^markdown\./);
  });
});

describe('two collections that declare DIFFERENT types for one file', () => {
  /** The conflicting pair, declared over the same glob. */
  const CONFLICTING: Readonly<Record<string, CollectionConfig>> = {
    asProse: { include: [TS_GLOB], mimeType: AS_PROSE },
    asData: { include: [TS_GLOB], mimeType: AS_DATA },
  };

  it('records the conflict as an error-severity condition naming both sides', async () => {
    const projection = await populateWith(CONFLICTING);
    const conditions = projection.realizationConditions
      .filter((row) => row.code === COLLECTION_MIME_CONFLICT);

    expect(conditions.length).toBeGreaterThan(0);
    expect(conditions[0]?.severity).toBe('error');
    // The fix is an edit to config.yaml, so a report that does not name both
    // collections and both types has told the author nothing actionable.
    expect(conditions[0]?.message).toContain('asProse');
    expect(conditions[0]?.message).toContain('asData');
    expect(conditions[0]?.message).toContain(AS_PROSE);
    expect(conditions[0]?.message).toContain(AS_DATA);
  });

  it('names the conflicted file by its ROOT-RELATIVE path', async () => {
    // An absolute path in a finding leaks `$HOME` and makes the report
    // machine-specific — the rule every other condition row here follows.
    const projection = await populateWith(CONFLICTING);
    const condition = projection.realizationConditions
      .find((row) => row.code === COLLECTION_MIME_CONFLICT);

    expect(toForwardSlash(condition?.path ?? '')).toBe(SUBJECT);
    expect(condition?.path).not.toContain(fixture.root());
  });

  it('completes the run, falling back to the built-in table for that file', async () => {
    // Not a throw on file 400 of 9,000: a config authoring mistake reads like a
    // linter finding, so the rest of the report has to survive it. The fallback
    // is the extension table's answer, which is what makes the run finishable.
    const projection = await populateWith(CONFLICTING);

    expect(rowFor(projection, SUBJECT)?.mime).toBe('text/x-typescript');
    expect(rowFor(projection, 'notes.md')).toBeDefined();
  });

  it('reports one conflict per file however many extents realize it', async () => {
    // The reason the resolver is built once per RUN rather than per extent. Two
    // extents realizing one mistyped file is one authoring mistake, and the
    // accumulator dedupes on the path — so the number of DISTINCT paths named
    // must stay 1 even though the fixture has a single extent today and would
    // otherwise not notice a per-extent resolver creeping back in.
    const projection = await populateWith(CONFLICTING);
    const paths = new Set(
      projection.realizationConditions
        .filter((row) => row.code === COLLECTION_MIME_CONFLICT)
        .map((row) => toForwardSlash(row.path)),
    );

    expect([...paths]).toStrictEqual(['strings.ts']);
  });
});

describe('a projection with no conflicting declarations', () => {
  it('emits no conflict condition at all', async () => {
    // The silence that must be real: every assertion above counts these rows, so
    // a producer that emitted one unconditionally would satisfy them all.
    const projection = await populateWith({
      sources: { include: [TS_GLOB], mimeType: AS_PROSE },
    });

    expect(projection.realizationConditions.filter((r) => r.code === COLLECTION_MIME_CONFLICT))
      .toStrictEqual([]);
  });
});
