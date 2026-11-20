/**
 * Reading the arm a subject SAID it ran out of its own stdout.
 *
 * Every case here is a way a row could name an arm the run never proved. The
 * reader must take the arm (`extentSource`) from the subject's output and
 * nowhere else: an env var says what was asked for, only the output says what
 * happened. Output that parses as neither JSON nor YAML, or whose root is not
 * an object, comes back as `null`. Inside an object a field that is absent or
 * malformed reads as `null`. That lenience is `io`'s contract alone — there the
 * arm qualifies counts that are real either way. `population` REFUSES a
 * malformed field through its own schema, which extends the shared
 * `LaneFieldsSchema`, before this reader sees the document (see
 * population-document.test.ts).
 */

import { describe, expect, it } from 'vitest';

import { armLabel, armOf, laneNote, readLaneFromOutput } from '../src/harness/lane.js';

/** A scan document as `vat resources scan --format json` prints it. */
function document(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: 'success',
    root: '/fixture/project',
    filesScanned: 2,
    extentSource: 'git',
    ...overrides,
  });
}

describe('readLaneFromOutput', () => {
  it('reads the extent source out of a JSON scan document', () => {
    expect(readLaneFromOutput(document())).toEqual({ extentSource: 'git' });
  });

  it('reports an explicit null extent source as null', () => {
    expect(readLaneFromOutput(document({ extentSource: null }))).toEqual({ extentSource: null });
  });

  it('reports a missing extentSource key as null', () => {
    const raw = JSON.parse(document()) as Record<string, unknown>;
    delete raw['extentSource'];

    expect(readLaneFromOutput(JSON.stringify(raw))).toEqual({ extentSource: null });
  });

  it('reads the arm out of the default YAML scan', () => {
    // The io/perf default spec prints YAML, and every reader in this package
    // goes through one shared parser (`document-shape.ts`) that reads both
    // JSON and YAML — so this output is readable here.
    expect(readLaneFromOutput('status: success\nextentSource: filesystem\nfilesScanned: 2\n')).toEqual({
      extentSource: 'filesystem',
    });
  });

  it('reports YAML that is not an object at the root as null', () => {
    expect(readLaneFromOutput('- 1\n- 2\n')).toEqual({ extentSource: null });
  });

  it('reports empty output as null', () => {
    expect(readLaneFromOutput('')).toEqual({ extentSource: null });
  });

  it('reports JSON that is not an object as null', () => {
    expect(readLaneFromOutput('[1, 2, 3]')).toEqual({ extentSource: null });
    expect(readLaneFromOutput('"git"')).toEqual({ extentSource: null });
  });

  it('keeps an unknown enumerator name verbatim rather than folding it into a known one', () => {
    expect(readLaneFromOutput(document({ extentSource: 'some-future-source' })).extentSource).toBe(
      'some-future-source',
    );
  });

  it('reads an extent source of the wrong type as unreported, never as a string', () => {
    // A number where an enumerator name should be is a document this build
    // cannot read an arm from. Coercing it would print `42` as an arm. This
    // lenience is io's contract alone — `population` refuses the same document
    // through its own schema before this reader sees it (see
    // population-document.test.ts).
    expect(readLaneFromOutput(document({ extentSource: 42 })).extentSource).toBeNull();
  });

  it('reads an empty-string extent source as unreported, never as a blank arm', () => {
    // `''` is a string, so only the shared schema's `min(1)` stands between it
    // and `armOf` returning `''` as the arm — a row that would render with a
    // blank where the arm goes, which is exactly what `armLabel` exists to
    // prevent. Pinned here, on the reader, and not only through the
    // population facet's refusal of the same document: if the two schemas were
    // ever split again, that test would keep passing while this reader let the
    // blank through.
    expect(readLaneFromOutput(document({ extentSource: '' })).extentSource).toBeNull();
  });
});

describe('armOf and armLabel', () => {
  it('names the arm as the extent source', () => {
    expect(armOf({ extentSource: 'git' })).toBe('git');
  });

  it('has no arm for a row whose extent source was not reported', () => {
    expect(armOf({ extentSource: null })).toBeNull();
    expect(armLabel({ extentSource: null })).toBe("arm UNREPORTED by the subject's output");
  });
});

describe('laneNote', () => {
  const git = { extentSource: 'git' };
  const filesystem = { extentSource: 'filesystem' };
  const unreported = { extentSource: null };

  it('names both arms when they differ', () => {
    expect(laneNote(filesystem, git)).toBe(' [filesystem → git]');
  });

  it('says out loud when both sides ran the same arm', () => {
    expect(laneNote(git, git)).toBe(
      " [both sides ran the 'git' arm — this compares one enumerator with itself]",
    );
  });

  it('says the arm is UNPROVEN when neither side reported one', () => {
    // Two nulls are not "the same arm" — they are two rows that cannot prove
    // which arm they ran, and a comparison between them is attributable to
    // nothing. Silence here would read as a clean pair.
    expect(laneNote(unreported, unreported)).toBe(
      ' [arm UNPROVEN on both sides — neither output reported an enumerator]',
    );
  });

  it('says which side is UNPROVEN when only the after side reported an arm', () => {
    // NOT the `[A → B]` form: that form means "the two sides ran different
    // enumerators", and a side that cannot prove which arm it ran is not a
    // different enumerator — it is an absent proof.
    const note = laneNote(unreported, git);

    expect(note).toBe(
      " [arm UNPROVEN on the before side — arm UNREPORTED by the subject's output; " +
        "the after side ran 'git']",
    );
    expect(note).not.toContain('→');
  });

  it('says which side is UNPROVEN when only the before side reported an arm', () => {
    const note = laneNote(git, unreported);

    expect(note).toBe(
      " [arm UNPROVEN on the after side — arm UNREPORTED by the subject's output; " +
        "the before side ran 'git']",
    );
    expect(note).not.toContain('→');
  });

  it('says nothing when a side is absent altogether', () => {
    expect(laneNote(null, git)).toBe('');
    expect(laneNote(git, null)).toBe('');
  });
});
