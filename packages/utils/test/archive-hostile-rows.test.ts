/**
 * Every hostile archive ({@link hostileArchiveRows}) is refused from its bytes and its entry list
 * alone — in memory, before an extraction would write anything. The integration suite shows the
 * same rows leave a real tree untouched; this shows the verdict never needed the tree, and that
 * each row is refused for the reason it names, not for some other fault of the fixture.
 */
import { describe, expect, it } from 'vitest';

import { listArchive } from '../src/archive/archive.js';
import { type ArchiveFormat, type ArchiveLimits, archiveEntryRefusal } from '../src/archive/entries.js';
import { isVatError } from '../src/errors/vat-error.js';
import { archiveFixture, type ArchiveFixtureEntry, hostileArchive, hostileArchiveRows } from '../src/testing/archive-fixtures.js';

/** Small enough that the two limit rows are a handful of entries. */
const LIMITS: ArchiveLimits = { maxEntries: 12, maxBytes: 4096 };

/** A sound skill the rows' entries are added to, under its folder. */
const SOUND: readonly ArchiveFixtureEntry[] = [{ name: 'skill/', kind: 'directory' }, { name: 'skill/SKILL.md', data: '# skill\n' }];

/** Why an archive is refused, judged in memory: the reader's refusal, or the policy's over what it listed. */
async function verdictOf(format: ArchiveFormat, bytes: Buffer): Promise<string | undefined> {
  try {
    return archiveEntryRefusal(await listArchive({ bytes, label: `fixture.${format}` }, { format, limits: LIMITS }))?.reason;
  } catch (error: unknown) {
    if (isVatError(error)) return (error as { reason?: string }).reason;
    throw error;
  }
}

describe.each(['tar', 'zip'] as const)('a hostile %s, judged in memory', (format) => {
  it('takes the sound archive the rows are added to', async () => {
    expect(await verdictOf(format, archiveFixture(format, SOUND))).toBeUndefined();
  });

  it.each(hostileArchiveRows(LIMITS).filter((row) => row.formats.includes(format)))('refuses $what as $reason', async (row) => {
    const bytes = hostileArchive(row, archiveFixture(format, [...SOUND, ...row.entries('skill/')]));

    expect(await verdictOf(format, bytes)).toBe(row.reason);
  });

  // At the top level as well as under a folder: a row's entries name the archive's root.
  it.each(hostileArchiveRows(LIMITS).filter((row) => row.formats.includes(format) && row.mangle === undefined))('refuses $what at the top level too', async (row) => {
    expect(await verdictOf(format, archiveFixture(format, row.entries('')))).toBe(row.reason);
  });
});
