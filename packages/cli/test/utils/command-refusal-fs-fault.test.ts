/**
 * A classified filesystem fault reaches the CLI's refusal through the schema table, and only a
 * classified one: an uncoded errno is still VAT's defect. The vocabulary utils classifies into and
 * the vocabulary the table is keyed by are one set, and the docs' errno table agrees with utils.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { FS_FAULT_REFUSALS } from '@vibe-agent-toolkit/schema';
import { classifyFsFault, FS_FAULT_ERRNOS_BY_CLASS, FS_SIDES, fsFaultOf, SOURCE_ORIGINS, type FsFaultContext } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { refusalCodeOf } from '../../src/utils/command-refusal.js';
import { NOTHING_FINISHED, refusalReport } from '../../src/utils/document-writer.js';

const errnoError = (code: string, path = '/p/x'): NodeJS.ErrnoException => Object.assign(new Error(`${code}: ${path}`), { code, path });
const classified = (code: string, ctx: FsFaultContext): unknown => classifyFsFault(errnoError(code), ctx);

/**
 * Every errno utils classifies, from the classifier's own table — never from `os.constants.errno`,
 * which is the HOST's list: Windows names no `EDQUOT` or `ESTALE`, and a check drawn from it said
 * the docs listed two errnos too many there.
 */
const CLASSIFIED_ERRNOS: ReadonlyMap<string, readonly string[]> = new Map(Object.entries(FS_FAULT_ERRNOS_BY_CLASS));
const TABLE_CLASSES = Object.keys(FS_FAULT_REFUSALS.destination);

describe('refusalCodeOf: a classified filesystem fault', () => {
  it('a full disk while READING a source is the run stopping, not the input', () => {
    expect(refusalCodeOf(classified('ENOSPC', { side: 'source', action: 'read the plugin source' }))).toBe('RUN_INCOMPLETE');
  });

  it('reads the table by side, class and origin', () => {
    expect(refusalCodeOf(classified('EACCES', { side: 'source', action: 'read' }))).toBe('INPUT_UNREADABLE');
    expect(refusalCodeOf(classified('ENOENT', { side: 'source', action: 'read', origin: 'argument' }))).toBe('USAGE_INVALID');
    expect(refusalCodeOf(classified('ENOENT', { side: 'source', action: 'read', origin: 'config' }))).toBe('CONFIG_INVALID');
    // A syscall's EEXIST is a race or VAT's sequencing, never the user's: a named, occupied destination is refused by preflight.
    expect(refusalCodeOf(classified('EEXIST', { side: 'destination', action: 'write the output' }))).toBe('RUN_INCOMPLETE');
    expect(refusalCodeOf(classified('EACCES', { side: 'destination', action: 'write the output' }))).toBe('RUN_INCOMPLETE');
    expect(refusalCodeOf(classified('EACCES', { side: 'environment', action: 'stage' }))).toBe('RUN_INCOMPLETE');
  });

  it('a raw errno nobody classified is still INTERNAL_ERROR: no errno walk', () => {
    expect(refusalCodeOf(errnoError('EACCES'))).toBe('INTERNAL_ERROR');
    expect(refusalCodeOf(new Error('wrapped', { cause: errnoError('ENOSPC') }))).toBe('INTERNAL_ERROR');
  });
});

describe('utils classifies into exactly the classes the schema table is keyed by', () => {
  const classes = new Set([...CLASSIFIED_ERRNOS.values()].flat().map((code) => fsFaultOf({ code })?.faultClass).filter((c) => c !== undefined));

  it('every class utils produces has a row', () => {
    expect([...classes].filter((c) => !TABLE_CLASSES.includes(c))).toEqual([]);
  });

  it('every row is a class utils produces', () => {
    expect(TABLE_CLASSES.filter((c) => !classes.has(c as never))).toEqual([]);
  });
});

describe('the schema table is keyed by exactly the sides and source origins utils classifies with', () => {
  it('sides', () => {
    expect(new Set(Object.keys(FS_FAULT_REFUSALS))).toEqual(new Set(FS_SIDES));
  });

  it('source origins', () => {
    expect(new Set(Object.keys(FS_FAULT_REFUSALS.source))).toEqual(new Set(SOURCE_ORIGINS));
  });
});

/** The errno table: from its section heading to the grid's marker, so no other table on the page can feed it. */
function errnoTableSection(): string {
  const docs = readFileSync(fileURLToPath(new URL('../../../../docs/validation-codes.md', import.meta.url)), 'utf8');
  const start = docs.indexOf('#### Filesystem faults: which refusal');
  const end = docs.indexOf('<!-- fs-fault-refusals -->', start);
  if (start === -1 || end === -1) throw new Error('docs/validation-codes.md: no filesystem-faults section ending at its grid marker');
  return docs.slice(start, end);
}

describe('docs/validation-codes.md lists the errnos of each class as utils classifies them', () => {
  const section = errnoTableSection();
  const listed = new Map(section.split('\n')
    .map((line) => /^\| ([a-z-]+) \| (`E.*|`UNKNOWN.*) \|$/.exec(line))
    .filter((match) => match !== null)
    .map((match) => [match[1] ?? '', (match[2] ?? '').split(', ').map((code) => code.replaceAll('`', ''))]));

  it('names every class', () => {
    expect(new Set(listed.keys())).toEqual(new Set(TABLE_CLASSES));
  });

  it.each(TABLE_CLASSES)('%s: exactly the errnos utils puts in it', (faultClass) => {
    const expected = CLASSIFIED_ERRNOS.get(faultClass) ?? [];
    expect(expected.length).toBeGreaterThan(0);
    // The table and the classifier are one thing: each errno it lists is classified into that class.
    expect(expected.filter((code) => fsFaultOf({ code })?.faultClass !== faultClass)).toEqual([]);
    expect(new Set(listed.get(faultClass))).toEqual(new Set(expected));
  });
});

describe('the published message of a classified fault', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const gate = { strict: false };
  const messageOf = (error: unknown): string | undefined => {
    const report = refusalReport(refusalCodeOf(error), error, gate, NOTHING_FINISHED);
    return report.status === 'error' ? report.error.message : undefined;
  };

  it('carries the table row remedy after what the OS said', () => {
    const error = classified('ENOSPC', { side: 'destination', action: 'write the output' });
    expect(messageOf(error)).toBe(`Could not write the output (ENOSPC): /p/x. ${FS_FAULT_REFUSALS.destination.exhausted.remedy}`);
  });

  it('never carries the remedy twice', () => {
    const error = classified('ENOSPC', { side: 'destination', action: `write the output. ${FS_FAULT_REFUSALS.destination.exhausted.remedy}` });
    const message = messageOf(error) ?? '';
    expect(message.split(FS_FAULT_REFUSALS.destination.exhausted.remedy)).toHaveLength(2);
  });

  it('leaves any other error message alone', () => {
    expect(messageOf(errnoError('EACCES'))).toBe('EACCES: /p/x');
  });
});
