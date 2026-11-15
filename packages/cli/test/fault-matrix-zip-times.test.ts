/**
 * The fault matrix compares a package's ZIP across runs: two runs that wrote the same entries at
 * different times must snapshot equal, and anything that is not a whole archive must not.
 */
import { zipFixture } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';

import { zipWithoutEntryTimes } from './fault-matrix/cases/zip-times.js';

/** A ZIP of the same two entries, each stamped `at`. */
function archiveAt(at: Date, body = 'notes\n'): Buffer {
  return zipFixture([
    { name: 'SKILL.md', data: '# skill\n', modified: at },
    { name: 'references/notes.md', data: body, modified: at },
  ]);
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
