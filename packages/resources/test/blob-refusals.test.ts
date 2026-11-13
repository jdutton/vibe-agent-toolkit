/**
 * The line a user sees when a population holds content it cannot vouch for.
 *
 * Unit tests over literal ROWS rather than over a corpus, deliberately: the
 * property under test is the FORMATTING RULE — which rows are refusals, which
 * are ordinary shapes of a tree, and what a clean population says — and the
 * rows are the whole input, so a store hit and a derive describe alike. The
 * end-to-end proof that a really-declined binary reaches this function lives in
 * `projection-blob-not-text-binary.test.ts`, over real PNG bytes.
 */
import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { parseRefusal } from '../src/not-admitted.js';
import { ParseLimitError } from '../src/parse-limits.js';
import {
  BLOB_CONTENT_CHANGED,
  BLOB_NOT_TEXT,
  BLOB_PARSE_FAILED,
  BLOB_PARSE_LIMIT_EXCEEDED,
  BLOB_UNREADABLE,
} from '../src/projection/blob-population.js';
import { describeBlobRefusals, notAdmittedRealizations, type BlobRefusalRows } from '../src/projection/blob-refusals.js';
import { POPULATION_PARSE_LIMITS } from '../src/projection/content-cache.js';
import { parseFailedMessage, parseFailureOf } from '../src/projection/parse-failure.js';
import type { BlobConditionRow, BlobRow } from '../src/schemas/projection-blobs.js';
import type { ContentState, ResourceRealizationRow } from '../src/schemas/projection-resources.js';

/** A derived blob; only the columns this function reads matter. */
function blob(contentKey: string, overrides: Partial<BlobRow> = {}): BlobRow {
  return { contentKey, encodingSource: 'assumed', replacementCharacters: 0, ...overrides } as BlobRow;
}

function blobs(count: number, overrides: Partial<BlobRow> = {}): BlobRow[] {
  return Array.from({ length: count }, (_, index) => blob(`markdown.derived-${index.toString()}`, overrides));
}

function condition(code: string, key: string): BlobConditionRow {
  return { blob: key, code, severity: 'warning', message: code, line: null } as BlobConditionRow;
}

function realization(path: string, contentState: ContentState): ResourceRealizationRow {
  return { path, contentState, contentKey: null, mime: null } as ResourceRealizationRow;
}

/** A keyed realization of `contentKey` at `path`, typed `mime` (null: a type the tables do not know). */
function keyedAt(path: string, contentKey: string, mime: string | null): ResourceRealizationRow {
  return { path, contentKey, contentState: 'keyed', mime } as ResourceRealizationRow;
}

/** The `code` Node gives a worker thread that reached its heap limit. */
const WORKER_OUT_OF_MEMORY_CODE = 'ERR_WORKER_OUT_OF_MEMORY';

function rowsOf(rows: Partial<BlobRefusalRows>): BlobRefusalRows {
  return { blobs: blobs(10), blobConditions: [], resourceRealizations: [], ...rows };
}

describe('describeBlobRefusals', () => {
  it('says nothing at all about a population that holds no refusal', () => {
    // Undefined rather than an empty string: a caller that forgets to check
    // would otherwise print a blank line on every clean run.
    expect(describeBlobRefusals(rowsOf({}))).toBeUndefined();
  });

  it('names each refused bucket with its count, and how many blobs it looked at', () => {
    const line = describeBlobRefusals(rowsOf({
      blobs: blobs(1380),
      resourceRealizations: [
        keyedAt('docs/a.md', 'markdown.png-1', 'text/markdown'),
        keyedAt('docs/b.md', 'markdown.png-2', 'text/markdown'),
      ],
      blobConditions: [
        condition(BLOB_NOT_TEXT, 'markdown.png-1'),
        condition(BLOB_NOT_TEXT, 'markdown.png-2'),
        condition(BLOB_UNREADABLE, 'markdown.locked'),
      ],
    }));

    expect(line).toContain('2 not text');
    expect(line).toContain('1 unreadable');
    // The denominator: "nothing was refused" and "nothing was enumerated" would
    // otherwise be the same line.
    expect(line).toContain('declined 3 of 1383 blob(s)');
    expect(line).toContain('blob_conditions');
  });

  it('counts a refused blob once however many paths realize it', () => {
    const line = describeBlobRefusals(rowsOf({
      resourceRealizations: [keyedAt('a.md', 'markdown.png', 'text/markdown'), keyedAt('b.md', 'markdown.png', 'text/markdown')],
      blobConditions: [condition(BLOB_NOT_TEXT, 'markdown.png'), condition(BLOB_NOT_TEXT, 'markdown.png')],
    }));

    expect(line).toContain('declined 1 of 11 blob(s) (1 not text)');
  });

  it('reads every refusal code, and ignores a condition that is not a refusal', () => {
    const line = describeBlobRefusals(rowsOf({
      blobConditions: [
        condition(BLOB_CONTENT_CHANGED, 'markdown.a'),
        condition(BLOB_PARSE_FAILED, 'markdown.b'),
        condition('PARSE_ODDITY', 'markdown.derived-0'),
      ],
    }));

    expect(line).toContain('declined 2 of 12 blob(s) (1 changed under the run, 1 parse failed)');
    expect(describeBlobRefusals(rowsOf({ blobConditions: [condition('PARSE_ODDITY', 'markdown.derived-0')] })))
      .toBeUndefined();
  });

  it('names what each failed parse threw — a worker that ran out of heap is not a corpus fault', () => {
    const threw = (code: string): Error => Object.assign(new Error('worker died'), { code });
    const failed = (key: string, error: unknown): BlobConditionRow =>
      ({ ...condition(BLOB_PARSE_FAILED, key), message: parseFailedMessage('markdown', error) });
    const line = describeBlobRefusals(rowsOf({
      blobConditions: [
        failed('markdown.a', threw(WORKER_OUT_OF_MEMORY_CODE)),
        failed('markdown.b', threw(WORKER_OUT_OF_MEMORY_CODE)),
        failed('markdown.c', new Error('Unexpected token (3:1)')),
      ],
    }));

    // Each distinct failure once, codes first — the code a reader can grep — then each message
    // quoted, so a message can never read as a code.
    expect(line).toContain('(3 parse failed [ERR_WORKER_OUT_OF_MEMORY, "Unexpected token (3:1)"])');
    expect(parseFailureOf(parseFailedMessage('markdown', threw(WORKER_OUT_OF_MEMORY_CODE)))).toEqual({ kind: 'code', text: WORKER_OUT_OF_MEMORY_CODE });
    expect(parseFailureOf('BLOB_PARSE_FAILED')).toBeUndefined();
  });

  it('reads back a message that looks like a code, holds the marker, or spans lines — unambiguously', () => {
    const tricky = [
      'ERR_LOOKS_LIKE_A_CODE',
      'The markdown parser threw on these bytes (code X) and then (more)',
      'line one\n\tline   two',
    ];
    for (const message of tricky) {
      const read = parseFailureOf(parseFailedMessage('markdown', new Error(message)));
      expect(read, message).toEqual({ kind: 'message', text: message.replaceAll(/\s+/g, ' ').trim() });
    }
    const line = describeBlobRefusals(rowsOf({
      blobConditions: [{ ...condition(BLOB_PARSE_FAILED, 'markdown.a'), message: parseFailedMessage('markdown', new Error('ERR_LOOKS_LIKE_A_CODE')) }],
    }));
    // A message is never printed as a code: it is quoted.
    expect(line).toContain('1 parse failed ["ERR_LOOKS_LIKE_A_CODE"]');
  });

  it('caps the failures on one line — every code kept, the messages cut to the first few and a count', () => {
    const threw = (code: string): Error => Object.assign(new Error('x'), { code });
    const failed = (key: string, error: unknown): BlobConditionRow =>
      ({ ...condition(BLOB_PARSE_FAILED, key), message: parseFailedMessage('markdown', error) });
    const messages = ['m1', 'm2', 'm3', 'm4', 'm5\nwith a second line'].map((text, index) => failed(`markdown.m${index.toString()}`, new Error(text)));
    const codes = ['ERR_Z', 'ERR_A', 'ERR_M', 'ERR_B'].map((code, index) => failed(`markdown.c${index.toString()}`, threw(code)));
    const line = describeBlobRefusals(rowsOf({ blobConditions: [...messages, ...codes] })) ?? '';

    expect(line).toContain('9 parse failed [ERR_A, ERR_B, ERR_M, ERR_Z, "m1", "m2", "m3", +2 more]');
    expect(line).not.toContain('\n');
  });

  it('reports realizations that could not be keyed, unreadable and refused by size apart', () => {
    const line = describeBlobRefusals(rowsOf({
      resourceRealizations: [
        realization('locked.md', 'unreadable'),
        realization('other.md', 'unreadable'),
        realization('huge.md', 'oversize'),
      ],
    }));

    expect(line).toContain('could not key 3 realization(s) (2 unreadable, 1 refused by size)');
    // Nothing was declined, so the pointer names the table that holds THESE rows.
    expect(line).toContain('resource_realizations');
    expect(line).not.toContain('blob_conditions');
  });

  it('counts an unkeyed path once however many extents realize it', () => {
    const line = describeBlobRefusals(rowsOf({
      resourceRealizations: [realization('huge.md', 'oversize'), realization('huge.md', 'oversize')],
    }));

    expect(line).toContain('could not key 1 realization(s) (1 refused by size)');
    expect(line).not.toContain('unreadable');
  });

  it('names both tables when both declined blobs and unkeyed realizations are present', () => {
    const line = describeBlobRefusals(rowsOf({
      resourceRealizations: [realization('huge.md', 'oversize')],
      blobConditions: [condition(BLOB_PARSE_FAILED, 'markdown.b')],
    }));

    expect(line).toContain('blob_conditions');
    expect(line).toContain('resource_realizations');
  });

  it('stays silent about a committed image: binary bytes at a path typed as no text', () => {
    // The wallpaper case: every image in a repository is a NUL-bearing blob,
    // and a line naming all of them on every run is read by no one.
    expect(describeBlobRefusals(rowsOf({
      resourceRealizations: [keyedAt('assets/logo.png', 'none.logo', null)],
      blobConditions: [condition(BLOB_NOT_TEXT, 'none.logo')],
    }))).toBeUndefined();
  });

  it('reports binary bytes at a path whose type says text, beside an image it stays silent about', () => {
    const line = describeBlobRefusals(rowsOf({
      resourceRealizations: [
        keyedAt('assets/logo.png', 'none.logo', null),
        keyedAt('docs/guide.md', 'markdown.corrupt', 'text/markdown'),
      ],
      blobConditions: [condition(BLOB_NOT_TEXT, 'none.logo'), condition(BLOB_NOT_TEXT, 'markdown.corrupt')],
    }));

    expect(line).toContain('declined 1 of 12 blob(s) (1 not text)');
  });

  it('reports binary bytes when ANY path realizing them is typed as text', () => {
    expect(describeBlobRefusals(rowsOf({
      resourceRealizations: [
        keyedAt('assets/logo.png', 'none.same', null),
        keyedAt('config/settings.json', 'none.same', 'application/json'),
      ],
      blobConditions: [condition(BLOB_NOT_TEXT, 'none.same')],
    }))).toContain('1 not text');
  });

  it('stays loud over a corpus that is ALL binary, typed or not', () => {
    // Nothing derived at all: "declined 1 of 1" is the line that says the run
    // read nothing it could use, and silence would hide exactly that.
    expect(describeBlobRefusals(rowsOf({
      blobs: [],
      resourceRealizations: [keyedAt('assets/logo.png', 'none.logo', null)],
      blobConditions: [condition(BLOB_NOT_TEXT, 'none.logo')],
    }))).toContain('declined 1 of 1 blob(s) (1 not text)');
  });

  it('stays silent about an image beside a SINGLE derived text blob — one is not "nothing derived"', () => {
    // The boundary of the all-binary case above: one usable blob means the run
    // read something, so the untyped image is wallpaper again.
    expect(describeBlobRefusals(rowsOf({
      blobs: blobs(1),
      resourceRealizations: [
        keyedAt('README.md', 'markdown.derived-0', 'text/markdown'),
        keyedAt('assets/logo.png', 'none.logo', null),
      ],
      blobConditions: [condition(BLOB_NOT_TEXT, 'none.logo')],
    }))).toBeUndefined();
  });

  it('stays silent for the ordinary shapes of a tree, which are not refusals', () => {
    expect(describeBlobRefusals(rowsOf({
      resourceRealizations: [
        realization('docs', 'none'),
        realization('deferred.md', 'deferred'),
        realization('a.md', 'keyed'),
      ],
    }))).toBeUndefined();
  });

  it('names the blobs it mis-decoded, how many characters were lost, and that they were guesses', () => {
    const line = describeBlobRefusals(rowsOf({
      blobs: [...blobs(1377), ...blobs(3, { replacementCharacters: 1000 }).map((row, index) => ({ ...row, contentKey: `markdown.bad-${index.toString()}` }))],
    }));

    expect(line).toContain('mis-decoded 3 of 1380 blob(s) into 3000 replacement character(s)');
    expect(line).toContain('all with no BOM, so the encoding was assumed');
    // A mis-decoded blob has no condition row, so the pointer names `blobs`.
    expect(line).toContain('replacementCharacters > 0');
  });

  it('separates the blobs whose encoding was a FACT from the ones that were guessed', () => {
    const line = describeBlobRefusals(rowsOf({
      blobs: [
        ...blobs(6),
        blob('markdown.bom-1', { encodingSource: 'bom', replacementCharacters: 3 }),
        blob('markdown.bom-2', { encodingSource: 'bom', replacementCharacters: 3 }),
        blob('markdown.bom-3', { encodingSource: 'bom', replacementCharacters: 3 }),
        blob('markdown.guess', { replacementCharacters: 3 }),
      ],
    }));

    expect(line).toContain('mis-decoded 4 of 10 blob(s) into 12 replacement character(s)');
    expect(line).toContain('1 with no BOM, so the encoding was assumed');
  });

  it('says the encoding was a fact when every mis-decoded blob carried a BOM', () => {
    const line = describeBlobRefusals(rowsOf({
      blobs: [...blobs(8), blob('markdown.bom', { encodingSource: 'bom', replacementCharacters: 9 })],
    }));

    expect(line).toContain('all with a BOM, so the encoding was a fact and the bytes are corrupt');
  });

  it('stays silent when every blob decoded cleanly, however many were assumed', () => {
    expect(describeBlobRefusals(rowsOf({ blobs: blobs(4425) }))).toBeUndefined();
    // Positive control: one mis-decode among them DOES speak.
    expect(describeBlobRefusals(rowsOf({
      blobs: [...blobs(4424), blob('markdown.bad', { replacementCharacters: 1 })],
    }))).toContain('mis-decoded 1 of 4425 blob(s)');
  });
});

// Built, never a POSIX literal: a drive-less root is not absolute on Windows.
const ROOT = safePath.resolve('corpus');

/** The log {@link notAdmittedRealizations} reads from `rows`, each unreadable entry as its path and code. */
function unreadableLog(rows: Parameters<typeof notAdmittedRealizations>[0]): { parseRefused: unknown[]; unreadable: Array<{ filePath: string; code: string | undefined }> } {
  const log = notAdmittedRealizations(rows, ROOT);
  return { parseRefused: [...log.parseRefused], unreadable: log.unreadable.map(({ filePath, code }) => ({ filePath, code })) };
}

describe('notAdmittedRealizations', () => {

  it('is empty for a population that admitted every realization', () => {
    expect(notAdmittedRealizations({
      blobConditions: [condition(BLOB_NOT_TEXT, 'none.png')],
      resourceRealizations: [keyedAt('a.md', 'markdown.a', 'text/markdown'), realization('dir', 'none'), realization('big.log', 'deferred')],
    }, ROOT)).toStrictEqual({ unreadable: [], parseRefused: [] });
  });

  it('logs an unreadable realization, and an oversize one of a kind nothing parses, as unreadable, the oversize one under the registry\'s TEXT_TOO_LARGE', () => {
    expect(unreadableLog({
      blobConditions: [],
      resourceRealizations: [realization('locked.md', 'unreadable'), realization('huge.md', 'oversize')],
    })).toStrictEqual({ parseRefused: [], unreadable: [
      { filePath: `${ROOT}/locked.md`, code: undefined },
      { filePath: `${ROOT}/huge.md`, code: 'TEXT_TOO_LARGE' },
    ] });
  });

  it('logs an oversize realization of a kind a parser reads as the parse-limit refusal the registry lane reports', () => {
    const huge = { ...realization('huge.md', 'oversize'), mime: 'text/markdown' } as ResourceRealizationRow;

    expect(notAdmittedRealizations({ blobConditions: [], resourceRealizations: [huge] }, ROOT)).toStrictEqual({
      unreadable: [],
      parseRefused: [{
        filePath: `${ROOT}/huge.md`,
        code: 'RESOURCE_PARSE_LIMIT_EXCEEDED',
        // The registry lane's own clause for the cap (`parseRefusal`), so the two lanes cannot drift.
        reason: parseRefusal(new ParseLimitError('inputBytes', POPULATION_PARSE_LIMITS.inputBytes)).reason,
      }],
    });
  });

  it('logs every realization of a blob it could not read, saw change, or failed to parse, each at its own path', () => {
    const failed: BlobConditionRow = {
      ...condition(BLOB_PARSE_FAILED, 'markdown.failed'),
      message: parseFailedMessage('markdown', Object.assign(new Error('boom'), { code: WORKER_OUT_OF_MEMORY_CODE })),
    };
    expect(unreadableLog({
      blobConditions: [condition(BLOB_UNREADABLE, 'markdown.gone'), condition(BLOB_CONTENT_CHANGED, 'markdown.moved'), failed],
      resourceRealizations: [
        keyedAt('gone.md', 'markdown.gone', 'text/markdown'),
        keyedAt('moved.md', 'markdown.moved', 'text/markdown'),
        keyedAt('failed.md', 'markdown.failed', 'text/markdown'),
        keyedAt('twin.md', 'markdown.failed', 'text/markdown'),
      ],
    })).toStrictEqual({ parseRefused: [], unreadable: [
      { filePath: `${ROOT}/gone.md`, code: undefined },
      { filePath: `${ROOT}/moved.md`, code: undefined },
      { filePath: `${ROOT}/failed.md`, code: WORKER_OUT_OF_MEMORY_CODE },
      { filePath: `${ROOT}/twin.md`, code: WORKER_OUT_OF_MEMORY_CODE },
    ] });
  });

  it('logs a parse refused for this run as parse-refused, never as unreadable', () => {
    const log = notAdmittedRealizations({
      blobConditions: [{ ...condition(BLOB_PARSE_LIMIT_EXCEEDED, 'markdown.deep'), message: 'its parse was stopped at its stackMb limit (1 MiB)' }],
      resourceRealizations: [keyedAt('deep.md', 'markdown.deep', 'text/markdown')],
    }, ROOT);

    expect(log.unreadable).toStrictEqual([]);
    expect(log.parseRefused).toStrictEqual([
      { filePath: `${ROOT}/deep.md`, code: 'RESOURCE_PARSE_LIMIT_EXCEEDED', reason: 'its parse was stopped at its stackMb limit (1 MiB)' },
    ]);
  });

  it('names a path once however many extents realize it', () => {
    const log = notAdmittedRealizations({
      blobConditions: [condition(BLOB_PARSE_LIMIT_EXCEEDED, 'markdown.deep')],
      resourceRealizations: [
        realization('locked.md', 'unreadable'),
        realization('locked.md', 'unreadable'),
        keyedAt('deep.md', 'markdown.deep', 'text/markdown'),
        keyedAt('deep.md', 'markdown.deep', 'text/markdown'),
      ],
    }, ROOT);

    expect(log.unreadable).toHaveLength(1);
    expect(log.parseRefused).toHaveLength(1);
  });
});
