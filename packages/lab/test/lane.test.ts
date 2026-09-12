/**
 * Reading the arm a subject SAID it ran out of its own stdout.
 *
 * Every case here is a way a row could name an arm the run never proved. The
 * reader must take the lane from the subject's output and nowhere else: an env
 * var says what was asked for, only the output says what happened — and a
 * subject that printed no JSON, or JSON with no `lane`, has to come back as
 * `null` on both fields rather than as anything a reader could mistake for a
 * real arm. `extentSource: null` is a different fact from a missing key (vat
 * emits `null` for the walk and omits the key on a build too old to say), and
 * the reader keeps the lane in both cases.
 */

import { describe, expect, it } from 'vitest';

import { armLabel, armOf, laneNote, readLaneFromOutput } from '../src/harness/lane.js';

/** A scan document as `vat resources scan --format json` prints it. */
function document(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: 'success',
    root: '/fixture/project',
    filesScanned: 2,
    lane: 'projection',
    extentSource: 'git',
    ...overrides,
  });
}

describe('readLaneFromOutput', () => {
  it('reads the lane and its extent source out of a JSON scan document', () => {
    expect(readLaneFromOutput(document())).toEqual({ lane: 'projection', extentSource: 'git' });
  });

  it('keeps the lane when the extent source is an explicit null, which is the walk', () => {
    // `null` is what vat prints for a lane with no extent to source. Refusing
    // it, or reading it as "did not say", would make every walk-lane document
    // read as an unproven arm.
    expect(readLaneFromOutput(document({ lane: 'walk', extentSource: null }))).toEqual({
      lane: 'walk',
      extentSource: null,
    });
  });

  it('reports a missing extentSource key as null, keeping the lane', () => {
    const raw = JSON.parse(document()) as Record<string, unknown>;
    delete raw['extentSource'];

    expect(readLaneFromOutput(JSON.stringify(raw))).toEqual({
      lane: 'projection',
      extentSource: null,
    });
  });

  it('reports a document with no lane as null on both fields', () => {
    const raw = JSON.parse(document()) as Record<string, unknown>;
    delete raw['lane'];
    delete raw['extentSource'];

    expect(readLaneFromOutput(JSON.stringify(raw))).toEqual({ lane: null, extentSource: null });
  });

  it('reports non-JSON output — the default YAML scan — as null on both fields', () => {
    // The io/perf default spec prints YAML. That output carries a `lane:` line a
    // human can read, and this reader must NOT read it: a YAML parser is a
    // dependency this package deliberately does not carry, and a regex over
    // the text would be a second parser that drifts from the first.
    expect(readLaneFromOutput('status: success\nlane: projection\nfilesScanned: 2\n')).toEqual({
      lane: null,
      extentSource: null,
    });
  });

  it('reports empty output as null on both fields', () => {
    expect(readLaneFromOutput('')).toEqual({ lane: null, extentSource: null });
  });

  it('reports JSON that is not an object as null on both fields', () => {
    expect(readLaneFromOutput('[1, 2, 3]')).toEqual({ lane: null, extentSource: null });
    expect(readLaneFromOutput('"projection"')).toEqual({ lane: null, extentSource: null });
  });

  it('keeps an unknown lane name verbatim rather than folding it into a known one', () => {
    expect(readLaneFromOutput(document({ lane: 'some-future-lane' })).lane).toBe(
      'some-future-lane',
    );
  });

  it('reads a lane of the wrong type as unreported, never as a string', () => {
    // A number where a lane name should be is a document this build cannot
    // read a lane from. Coercing it would print `42` as an arm. This lenience
    // is io's contract alone — there the arm qualifies counts that are real
    // either way. `population` refuses the same document through its own
    // schema before this reader sees it (see population-document.test.ts).
    expect(readLaneFromOutput(document({ lane: 42 })).lane).toBeNull();
  });

  it('reads the two fields independently, so a bad extent source cannot erase a good lane', () => {
    // The subject DID report its lane. Discarding it because the qualifier
    // beside it is unreadable would render a run that named its arm as one
    // that named none.
    expect(readLaneFromOutput(document({ lane: 'projection', extentSource: 42 }))).toEqual({
      lane: 'projection',
      extentSource: null,
    });
  });

  it('reads the two fields independently the other way round as well', () => {
    // No lane, but an extent source: the extent source is still what the
    // output said, and `armOf` decides what to make of a lane-less row.
    expect(readLaneFromOutput(document({ lane: 42, extentSource: 'git' }))).toEqual({
      lane: null,
      extentSource: 'git',
    });
  });
});

describe('armOf and armLabel', () => {
  it('names the arm as the lane qualified by its extent source', () => {
    expect(armOf({ lane: 'projection', extentSource: 'git' })).toBe('projection via git');
  });

  it('names a lane with no extent source bare', () => {
    expect(armOf({ lane: 'walk', extentSource: null })).toBe('walk');
  });

  it('has no arm for a row whose lane was not reported', () => {
    expect(armOf({ lane: null, extentSource: null })).toBeNull();
    expect(armLabel({ lane: null, extentSource: null })).toBe(
      "lane UNREPORTED by the subject's output",
    );
  });
});

describe('laneNote', () => {
  const git = { lane: 'projection', extentSource: 'git' };
  const filesystem = { lane: 'projection', extentSource: 'filesystem' };
  const unreported = { lane: null, extentSource: null };

  it('names both arms when they differ', () => {
    expect(laneNote(filesystem, git)).toBe(' [projection via filesystem → projection via git]');
  });

  it('says out loud when both sides ran the same arm', () => {
    expect(laneNote(git, git)).toBe(
      " [both sides ran the 'projection via git' arm — this compares one enumerator with itself]",
    );
  });

  it('says the arm is UNPROVEN when neither side reported one', () => {
    // Two nulls are not "the same arm" — they are two rows that cannot prove
    // which arm they ran, and a comparison between them is attributable to
    // nothing. Silence here would read as a clean pair.
    expect(laneNote(unreported, unreported)).toBe(
      ' [arm UNPROVEN on both sides — neither output reported a lane]',
    );
  });

  it('names the reported side and the unreported side when only one said', () => {
    expect(laneNote(unreported, git)).toBe(
      " [lane UNREPORTED by the subject's output → projection via git]",
    );
  });

  it('says nothing when a side is absent altogether', () => {
    expect(laneNote(null, git)).toBe('');
    expect(laneNote(git, null)).toBe('');
  });
});
