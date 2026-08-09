/**
 * The three-axis coordinate every report is measured at.
 *
 * A number produced by this package is meaningless without knowing *what* was
 * measured, *which version of it*, and *with which build of the instrument*.
 * Those are the three axes, and a report that omits any of them is comparable
 * to nothing:
 *
 * - **A, `subject`** — which repository or folder.
 * - **B, `subjectVersion`** — which commit of it, or which snapshot of a folder
 *   that has no commits.
 * - **C, `instrument`** — which build of vat did the measuring.
 *
 * A comparison holds two axes still and varies one. Vary C and you are asking
 * whether vat got better or faster. Vary B and you are asking what moved
 * upstream. Vary A and you are surveying an ecosystem. Vary two at once and the
 * answer means nothing, which is why {@link decideComparison} refuses by
 * default rather than reporting a delta nobody can attribute.
 *
 * **Subjects are tracked on moving refs on purpose.** A seed entry points at
 * `#main`, because upstream moving *is* the signal a survey exists to see.
 * Pinning happens at observation time instead: the run resolves whatever ref it
 * was given to a concrete commit and stamps it here, so the subject keeps
 * moving while every report stays retrospectively pinned and diffable.
 */

import { z } from 'zod';

/** Axis A — the thing measured, and how it was named. */
export interface SubjectRef {
  /** Stable identifier, unique within a corpus registry. */
  readonly id: string;
  /** How it was named: a git URL with a ref, or a filesystem path. */
  readonly source: string;
}

/**
 * Axis B — which version of the subject.
 *
 * Two kinds, because not every subject has commits. A working folder handed
 * straight to the tool is pinned by a content fingerprint instead, which is the
 * only thing that can make two runs over it comparable.
 */
export type SubjectVersion =
  | {
      readonly kind: 'git';
      /** The resolved commit. Always concrete — never a branch name. */
      readonly commit: string;
      /** The ref this commit was resolved *from*, or `null` for a bare SHA. */
      readonly ref: string | null;
      /**
       * Whether the working tree had changes the commit does not describe.
       *
       * A dirty checkout is **not** honestly identified by its HEAD alone — the
       * bytes measured were not the bytes at that commit. But refusing to
       * measure one would forbid the most common thing a developer does:
       * iterate on a change and watch the number move. So a dirty tree is
       * measurable and *labelled*, never silently stamped with a commit it does
       * not match.
       */
      readonly dirty: boolean;
      /**
       * Content fingerprint of the working tree, present exactly when `dirty`.
       *
       * This is what keeps a dirty subject comparable *to itself*: two runs over
       * an unchanged dirty tree share a fingerprint and can be diffed, while a
       * further edit changes it and correctly reads as a moved subject. Without
       * it, every dirty run would look like the same version as every other.
       */
      readonly workingFingerprint: string | null;
    }
  | {
      readonly kind: 'snapshot';
      /** Content fingerprint over the files in scope. */
      readonly fingerprint: string;
      /** How many files the fingerprint covers, for a cheap sanity read. */
      readonly fileCount: number;
    };

/**
 * Axis C — which build of vat measured this.
 *
 * `commit` is not decoration. Every dev build in this repo carries the same
 * semver as the release it branched from, so a comparison keyed on `version`
 * alone would read a dev build and a release as the same instrument — and that
 * is precisely the comparison this package exists to make.
 */
export interface InstrumentVersion {
  /** The vat version under measurement. */
  readonly version: string;
  /** Its git commit, when the build was made from a checkout. */
  readonly commit: string | null;
}

/** A complete three-axis coordinate. */
export interface Coordinate {
  readonly subject: SubjectRef;
  readonly subjectVersion: SubjectVersion;
  readonly instrument: InstrumentVersion;
}

/** The axes, in report order. */
export type Axis = 'subject' | 'subjectVersion' | 'instrument';

export const SubjectRefSchema = z
  .object({
    id: z.string().min(1),
    source: z.string().min(1),
  })
  .strict();

const SubjectVersionVariants = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('git'),
      commit: z.string().min(1),
      ref: z.string().min(1).nullable(),
      dirty: z.boolean(),
      workingFingerprint: z.string().min(1).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('snapshot'),
      fingerprint: z.string().min(1),
      fileCount: z.number().int().nonnegative(),
    })
    .strict(),
]);

/**
 * Axis B, with the one cross-field rule the variants cannot express alone.
 *
 * The pairing IS the contract: a clean tree has nothing to fingerprint, and a
 * dirty one is comparable to itself only *because* of the fingerprint. A dirty
 * version without one would read as equal to every other dirty run at the same
 * commit — which is precisely the confusion the field was added to prevent.
 */
export const SubjectVersionSchema = SubjectVersionVariants.superRefine((value, ctx) => {
  if (value.kind !== 'git') return;
  if (value.dirty === (value.workingFingerprint !== null)) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['workingFingerprint'],
    message: value.dirty
      ? 'a dirty git subject must carry a workingFingerprint'
      : 'a clean git subject must not carry a workingFingerprint',
  });
});

export const InstrumentVersionSchema = z
  .object({
    version: z.string().min(1),
    commit: z.string().min(1).nullable(),
  })
  .strict();

export const CoordinateSchema = z
  .object({
    subject: SubjectRefSchema,
    subjectVersion: SubjectVersionSchema,
    instrument: InstrumentVersionSchema,
  })
  .strict();

/**
 * Is this the same subject — the same entry in the same registry?
 *
 * @param a - One subject
 * @param b - The other
 * @returns `true` when both fields match
 */
function sameSubject(a: SubjectRef, b: SubjectRef): boolean {
  return a.id === b.id && a.source === b.source;
}

/**
 * Is this the same version of a subject?
 *
 * A kind change counts as a move: the same tree measured once as a checkout and
 * once as a bare folder is not the same observation, and silently treating it
 * as one would hide the difference between the two routes.
 *
 * @param a - One subject version
 * @param b - The other
 * @returns `true` when the kind and every field of that kind match
 */
function sameSubjectVersion(a: SubjectVersion, b: SubjectVersion): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'git' && b.kind === 'git') {
    // The fingerprint is what makes two dirty runs distinguishable. Comparing
    // the commit alone would call every dirty run at one commit the same
    // version, which is the failure the fingerprint exists to prevent.
    return (
      a.commit === b.commit &&
      a.dirty === b.dirty &&
      a.workingFingerprint === b.workingFingerprint
    );
  }
  if (a.kind === 'snapshot' && b.kind === 'snapshot') return a.fingerprint === b.fingerprint;
  return false;
}

/**
 * Is this the same build of the instrument?
 *
 * @param a - One instrument version
 * @param b - The other
 * @returns `true` when version and commit both match
 */
function sameInstrument(a: InstrumentVersion, b: InstrumentVersion): boolean {
  return a.version === b.version && a.commit === b.commit;
}

/**
 * Which axes differ between two coordinates.
 *
 * **`subjectVersion` is subordinate to `subject`.** When the subject itself
 * changed, the commits necessarily differ too — but that is a restatement of
 * "these are different repositories", not a second independent change. Counting
 * it separately would make every cross-project survey look like a two-axis
 * comparison and refuse.
 *
 * @param a - One coordinate
 * @param b - The other
 * @returns The axes that moved, in report order; empty when the two are identical
 */
export function movedAxes(a: Coordinate, b: Coordinate): readonly Axis[] {
  const moved: Axis[] = [];
  const subjectMoved = !sameSubject(a.subject, b.subject);
  if (subjectMoved) moved.push('subject');
  // Subordinate: only meaningful while the subject is held still.
  if (!subjectMoved && !sameSubjectVersion(a.subjectVersion, b.subjectVersion)) {
    moved.push('subjectVersion');
  }
  if (!sameInstrument(a.instrument, b.instrument)) moved.push('instrument');
  return moved;
}

/** The outcome of asking whether two reports may be compared. */
export type ComparisonDecision =
  | {
      readonly ok: true;
      /** The single axis that varies, or `null` when nothing moved. */
      readonly axis: Axis | null;
    }
  | {
      readonly ok: false;
      /** Human-facing refusal, prefixed `REFUSED:`. */
      readonly refusal: string;
      /** Every axis that moved. */
      readonly moved: readonly Axis[];
    };

/** Options for {@link decideComparison}. */
export interface DecideComparisonOptions {
  /**
   * Compare anyway when more than one axis moved.
   *
   * There is no honest default for this. A delta across two simultaneous
   * changes cannot be attributed to either, so the caller has to say out loud
   * that they know the result is uninterpretable.
   */
  readonly allowMultiAxis?: boolean;
}

/**
 * May these two reports be compared, and along which axis?
 *
 * @param a - The baseline coordinate
 * @param b - The coordinate being compared against it
 * @param options - See {@link DecideComparisonOptions}
 * @returns A decision naming the varying axis, or a refusal naming all of them
 */
export function decideComparison(
  a: Coordinate,
  b: Coordinate,
  options: DecideComparisonOptions = {},
): ComparisonDecision {
  const moved = movedAxes(a, b);
  if (moved.length <= 1) return { ok: true, axis: moved[0] ?? null };
  if (options.allowMultiAxis === true) return { ok: true, axis: null };
  return {
    ok: false,
    moved,
    refusal:
      `REFUSED: ${String(moved.length)} axes moved between these reports (${moved.join(', ')}). ` +
      'A delta across two simultaneous changes cannot be attributed to either of them. ' +
      'Hold all but one axis still, or pass allowMultiAxis to compare anyway.',
  };
}
