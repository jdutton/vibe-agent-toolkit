/**
 * The three-axis coordinate is what makes any two reports comparable. These
 * tests pin the two decisions that are easy to get wrong and expensive to get
 * wrong late:
 *
 * 1. **`subjectVersion` is subordinate to `subject`.** Two different repos have
 *    unrelated commit histories, so "the commits differ" is not a second
 *    independent change — it is a restatement of "these are different repos".
 *    Counting it independently would make every cross-project survey refuse.
 * 2. **The instrument's commit distinguishes builds at the same version.** Every
 *    dev build in this repo carries the same semver as the release it branched
 *    from, so comparing on `version` alone would silently read a dev build and a
 *    release as the same instrument — exactly the comparison the tool exists to
 *    make.
 */

import { describe, expect, it } from 'vitest';

import {
  type Coordinate,
  decideComparison,
  type InstrumentVersion,
  movedAxes,
  type SubjectVersion,
} from '../src/envelope/coordinate.js';

const GIT_A: SubjectVersion = { kind: 'git', commit: 'a'.repeat(40), ref: 'main', dirty: false, workingFingerprint: null };
const GIT_B: SubjectVersion = { kind: 'git', commit: 'b'.repeat(40), ref: 'main', dirty: false, workingFingerprint: null };
const VAT_RELEASE: InstrumentVersion = { version: '0.1.42', commit: '1'.repeat(40) };
const VAT_DEV: InstrumentVersion = { version: '0.1.42', commit: '2'.repeat(40) };

/**
 * Build a coordinate, overriding only the axis under test.
 *
 * @param over - Fields to replace on the baseline coordinate
 * @returns A complete coordinate
 */
function coord(over: Partial<Coordinate> = {}): Coordinate {
  return {
    subject: { id: 'upstream-skills', source: 'https://github.com/example/skills.git#main' },
    subjectVersion: GIT_A,
    instrument: VAT_RELEASE,
    ...over,
  };
}

describe('movedAxes', () => {
  it('reports no movement between identical coordinates', () => {
    expect(movedAxes(coord(), coord())).toEqual([]);
  });

  it('reports the instrument axis when only the vat build differs', () => {
    expect(movedAxes(coord(), coord({ instrument: VAT_DEV }))).toEqual(['instrument']);
  });

  it('distinguishes two instrument builds sharing one version string', () => {
    // The positive control for the test above: if `commit` were ignored, this
    // pair would read as identical, and every dev-vs-release run would compare
    // an instrument against itself.
    expect(VAT_DEV.version).toBe(VAT_RELEASE.version);
    expect(movedAxes(coord(), coord({ instrument: VAT_DEV }))).not.toEqual([]);
  });

  it('reports the subjectVersion axis when the same repo moved commit', () => {
    expect(movedAxes(coord(), coord({ subjectVersion: GIT_B }))).toEqual(['subjectVersion']);
  });

  it('reports a subjectVersion move when the same subject switches kind', () => {
    const snapshot: SubjectVersion = { kind: 'snapshot', fingerprint: 'deadbeef', fileCount: 12 };
    expect(movedAxes(coord(), coord({ subjectVersion: snapshot }))).toEqual(['subjectVersion']);
  });

  it('treats subjectVersion as subordinate when the subject itself changed', () => {
    // Different repos, and necessarily different commits. Only ONE thing moved.
    const other = coord({
      subject: { id: 'other-skills', source: 'https://github.com/example/other.git#main' },
      subjectVersion: GIT_B,
    });
    expect(movedAxes(coord(), other)).toEqual(['subject']);
  });

  it('reports both axes when the subject and the instrument moved', () => {
    const other = coord({
      subject: { id: 'other-skills', source: 'https://github.com/example/other.git#main' },
      subjectVersion: GIT_B,
      instrument: VAT_DEV,
    });
    expect(movedAxes(coord(), other)).toEqual(['subject', 'instrument']);
  });
});

describe('decideComparison', () => {
  it('permits comparing a coordinate with itself, naming no axis', () => {
    const decision = decideComparison(coord(), coord());
    expect(decision).toEqual({ ok: true, axis: null });
  });

  it('permits a single-axis comparison and names the axis', () => {
    const decision = decideComparison(coord(), coord({ instrument: VAT_DEV }));
    expect(decision).toEqual({ ok: true, axis: 'instrument' });
  });

  it('refuses when two axes moved, naming both', () => {
    const decision = decideComparison(coord(), coord({ subjectVersion: GIT_B, instrument: VAT_DEV }));
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.moved).toEqual(['subjectVersion', 'instrument']);
    expect(decision.refusal).toMatch(/^REFUSED:/);
    expect(decision.refusal).toContain('subjectVersion');
    expect(decision.refusal).toContain('instrument');
  });

  it('permits a multi-axis comparison only when explicitly asked', () => {
    const decision = decideComparison(coord(), coord({ subjectVersion: GIT_B, instrument: VAT_DEV }), {
      allowMultiAxis: true,
    });
    expect(decision).toEqual({ ok: true, axis: null });
  });
});
