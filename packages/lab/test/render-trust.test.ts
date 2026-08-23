/**
 * What a report and a comparison say about the build that produced them.
 *
 * The defect these pin shipped and was found by reading a real run's output: a
 * `tree:` instrument built from a working tree with substantial uncommitted
 * changes printed
 *
 * ```
 * Subject:    branch @ dd4123f4 (DIRTY working tree)
 * Instrument: vat 0.2.0-rc.2 (7b65ba86)
 * ```
 *
 * — the subject side disclosing exactly what the instrument side hid. Every
 * assertion below is paired with a negative control, because a banner that
 * appears unconditionally is no more informative than one that never appears.
 */

import { describe, expect, it } from 'vitest';

import type { InstrumentVersion } from '../src/envelope/coordinate.js';
import { coordinateLines, instrumentLabel, instrumentTrustNotes } from '../src/harness/render.js';

import { COORDINATE } from './report-fixtures.js';

const CLEAN: InstrumentVersion = { version: '0.2.0-rc.2', commit: '7b65ba86'.repeat(5), dirty: false };
const DIRTY: InstrumentVersion = { ...CLEAN, dirty: true };
const OTHER_CLEAN: InstrumentVersion = { ...CLEAN, commit: 'a'.repeat(40) };
const RELEASED: InstrumentVersion = { version: '0.1.41', commit: null, dirty: null };

/**
 * Every note the two arms produce, as one string.
 *
 * @param before - The baseline instrument
 * @param after - The instrument compared against it
 * @returns The notes joined, or the empty string when there are none
 */
function notes(before: InstrumentVersion, after: InstrumentVersion): string {
  return instrumentTrustNotes(before, after).join('\n');
}

describe('instrumentLabel', () => {
  it('marks a dirty build in the same words the subject line uses', () => {
    expect(instrumentLabel(DIRTY)).toContain('DIRTY working tree');
  });

  it('says nothing extra about a clean build', () => {
    // The negative control. Without it, "the label mentions DIRTY" would pass
    // for a renderer that appended the words to every instrument.
    expect(instrumentLabel(CLEAN)).toBe('vat 0.2.0-rc.2 (7b65ba86)');
  });

  it('calls a build with no commit released rather than inventing one', () => {
    expect(instrumentLabel(RELEASED)).toBe('vat 0.1.41 (released)');
  });
});

describe('coordinateLines', () => {
  it('carries the instrument dirtiness into the header both facets share', () => {
    const rendered = coordinateLines({ ...COORDINATE, instrument: DIRTY }).join('\n');

    expect(rendered).toContain('Instrument: vat 0.2.0-rc.2 (7b65ba86, DIRTY working tree)');
  });

  it('leaves the header clean when the instrument is', () => {
    expect(coordinateLines({ ...COORDINATE, instrument: CLEAN }).join('\n')).not.toContain('DIRTY');
  });
});

describe('instrumentTrustNotes', () => {
  it('says nothing when both arms are pinned, clean checkouts', () => {
    // The control every other case is read against.
    expect(instrumentTrustNotes(CLEAN, OTHER_CLEAN)).toEqual([]);
  });

  it('warns loudly when either arm was built from a dirty tree', () => {
    expect(notes(DIRTY, OTHER_CLEAN)).toContain('INSTRUMENT NOT PINNED');
    expect(notes(OTHER_CLEAN, DIRTY)).toContain('INSTRUMENT NOT PINNED');
  });

  it('names which arms are dirty, so a reader knows where to look', () => {
    expect(notes(DIRTY, OTHER_CLEAN)).toContain('baseline built from a DIRTY working tree');
    expect(notes(OTHER_CLEAN, DIRTY)).toContain('candidate built from a DIRTY working tree');
    expect(notes(DIRTY, { ...DIRTY, commit: 'b'.repeat(40) })).toContain('both arms built from');
  });

  it('flags arms that differ in dirtiness as a separate hazard', () => {
    // Distinct from "an arm is dirty": here part of the delta is uncommitted
    // work rather than the change under test, which is a different sentence.
    expect(notes(CLEAN, DIRTY)).toContain('ARMS DIFFER IN DIRTINESS');
    // Two dirty arms are dirty but do not DIFFER, so this second note stays off.
    expect(notes(DIRTY, DIRTY)).not.toContain('ARMS DIFFER IN DIRTINESS');
  });

  it('flags an arm with no commit — the known dist:/npx: blind spot', () => {
    // `movedAxes` cannot see a build change between two commit-less arms, so a
    // genuine two-build comparison reports that nothing moved.
    expect(notes(RELEASED, CLEAN)).toContain('NO COMMIT ON BASELINE');
    expect(notes(RELEASED, { ...RELEASED, version: '0.1.42' })).toContain('NO COMMIT ON BOTH ARMS');
    expect(notes(CLEAN, OTHER_CLEAN)).not.toContain('NO COMMIT');
  });
});
