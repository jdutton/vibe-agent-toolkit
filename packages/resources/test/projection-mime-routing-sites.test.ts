/**
 * Every site that decides a file's parser kind agrees on one file a collection
 * re-types.
 *
 * A collection declaring `mimeType: 'text/markdown'` over `**\/*.ts` pulls a
 * `.ts` file onto the markdown parser. Several sites each answer "which parser
 * reads this file?" on their own: the projection lane, the registry lane, the
 * warm stored-admission decision and the not-admitted log's refusal rule. This
 * suite pins that they all say `markdown` for the same file, so a site that
 * starts deciding from the path alone (or from nothing) goes red here rather
 * than quietly parsing a re-typed file one way on one lane and another way on
 * the next.
 *
 * It characterises today's code: one recorded divergence (the path-only
 * `parserKindForPath`) is asserted as it stands, with its reason, so a change
 * to it is a visible decision rather than an accident.
 */

import { toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { parseRefusal } from '../src/not-admitted.js';
import { ParseLimitError } from '../src/parse-limits.js';
import { unkeyedEntry } from '../src/projection/blob-refusals.js';
import { POPULATION_PARSE_LIMITS } from '../src/projection/content-cache.js';
import { parserKindForPath } from '../src/projection/router.js';
import { storedRoute, type StoredRealization } from '../src/projection/stored-admission.js';
import { ResourceRegistry } from '../src/resource-registry.js';
import type { CollectionConfig } from '../src/schemas/project-config.js';

import { crawlInRun, populateFilesystem } from './helpers/population-run.js';
import { setupTempCorpus } from './helpers/temp-corpus.js';

/** The re-typed file, and the type the collection gives it. */
const SUBJECT = 'strings.ts';
const AS_PROSE = 'text/markdown';

/**
 * One `.ts` file carrying a markdown link, and one `.md` control.
 *
 * NOT byte-identical: blobs are content-addressed, so twins with identical
 * bytes routed to one parser would collapse into one blob and an assertion
 * about `strings.ts` could be answered by `notes.md`.
 */
const fixture = setupTempCorpus('vat-mime-sites-', {
  'notes.md': '# Notes\n\nThe control: [target](./notes.md) in real prose.\n',
  'strings.ts': '// marker: sites\nexport const s = "[target](./notes.md)";\n',
});

/** The one collection every site in this suite is asked about. */
const COLLECTIONS: Readonly<Record<string, CollectionConfig>> = {
  sources: { include: ['**/*.ts'], mimeType: AS_PROSE },
};

/** The input-cap refusal a parsed kind's oversize file is logged with, on every lane. */
const INPUT_CAP_REFUSAL = {
  log: 'parseRefused',
  entry: parseRefusal(new ParseLimitError('inputBytes', POPULATION_PARSE_LIMITS.inputBytes)),
};

/** What the store holds for the subject when it was too large to read: the declared type, no key. */
const OVERSIZE: StoredRealization = { contentKey: null, contentState: 'oversize', mime: AS_PROSE };

describe('a .ts file a collection types text/markdown: every parser-kind site agrees', () => {
  it('projection lane: populate() types it text/markdown and keys it under the markdown parser', async () => {
    const projection = await populateFilesystem(fixture.root(), COLLECTIONS);

    const row = projection.resourceRealizations.find((r) => toForwardSlash(r.path) === SUBJECT);
    expect(row?.mime).toBe(AS_PROSE);
    expect(row?.contentKey).toMatch(/^markdown\./);
  });

  it('registry lane: ResourceRegistry under the same config parses it as markdown', async () => {
    const root = fixture.root();
    const registry = new ResourceRegistry({ baseDir: root, config: { resources: { collections: COLLECTIONS } } });
    await crawlInRun(registry, { ignoredRefusals: 'record', unreadable: 'refuse', outputs: [], baseDir: root, include: ['**/*.ts'] });

    const resource = registry.getAllResources().find((r) => toForwardSlash(r.filePath).endsWith(`/${SUBJECT}`));
    // The key prefix is the parse route; the link is the proof the markdown parser read the bytes.
    expect(resource?.contentKey).toMatch(/^markdown\./);
    expect(resource?.links.map((link) => link.href)).toContain('./notes.md');
  });

  it('stored admission: an oversize realization of that type is the input-cap refusal under markdown, cold under none', () => {
    expect(storedRoute(OVERSIZE, 'markdown')).toEqual({ kind: 'not-admitted', entry: INPUT_CAP_REFUSAL });
    // A view that routes the file to no parser asks another question of the same bytes.
    expect(storedRoute(OVERSIZE, 'none')).toEqual({ kind: 'compute' });
  });

  it('blob refusals: the not-admitted log words that oversize realization as the parse refusal', () => {
    expect(unkeyedEntry({ contentState: 'oversize', mime: AS_PROSE })).toEqual(INPUT_CAP_REFUSAL);
  });

  it('path-only callers: parserKindForPath answers none (recorded divergence)', () => {
    // Recorded divergence, not agreement: `parserKindForPath` sees only the
    // extension and knows nothing of collections, so it cannot honour a
    // declared mimeType and answers `none` for a `.ts` file every site above
    // reads as markdown. Its callers are the ones with no project config in
    // reach. Pinned here so moving it onto the collection resolver (or letting
    // a config-aware site fall back to it) is a deliberate, visible change.
    expect(parserKindForPath(SUBJECT)).toBe('none');
  });
});
