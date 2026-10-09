/**
 * The fault matrix compares a package's ZIP across runs: two runs that wrote the same entries at
 * different times must snapshot equal, and anything that is not a whole archive must not.
 */
import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';

import { zipWithoutEntryTimes } from './fault-matrix/cases/zip-times.js';

/** A ZIP of the same two entries, each stamped `at`. */
function archiveAt(at: Date, body = 'notes\n'): Buffer {
  const zip = new AdmZip();
  zip.addFile('SKILL.md', Buffer.from('# skill\n'));
  zip.addFile('references/notes.md', Buffer.from(body));
  for (const entry of zip.getEntries()) entry.header.time = at;
  return zip.toBuffer();
}

describe('zipWithoutEntryTimes', () => {
  const morning = new Date(2026, 9, 8, 9, 0, 0);
  const evening = new Date(2026, 9, 8, 21, 30, 44);

  it('two archives of the same entries written at different times come out byte-equal', () => {
    const [a, b] = [archiveAt(morning), archiveAt(evening)];
    expect(a.equals(b)).toBe(false);
    expect(zipWithoutEntryTimes(a).equals(zipWithoutEntryTimes(b))).toBe(true);
  });

  it('archives whose entries differ still differ', () => {
    expect(zipWithoutEntryTimes(archiveAt(morning)).equals(zipWithoutEntryTimes(archiveAt(morning, 'other\n')))).toBe(false);
  });

  it('an archive whose central directory points at no local header comes back unchanged', () => {
    const broken = Buffer.from(archiveAt(morning));
    broken.writeUInt32LE(0, 0);
    expect(zipWithoutEntryTimes(broken)).toBe(broken);
  });

  it('a truncated archive, or bytes that are no archive, come back unchanged', () => {
    const truncated = archiveAt(morning).subarray(0, 40);
    const standIn = Buffer.from('a previous archive');
    expect(zipWithoutEntryTimes(truncated)).toBe(truncated);
    expect(zipWithoutEntryTimes(standIn)).toBe(standIn);
  });
});
