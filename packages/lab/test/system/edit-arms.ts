/**
 * What the edit-arm and trace system files share: a twelve-file committed
 * subject, the built candidate as one build `b`, and one three-round
 * `captureArms` invocation over a lab-shaped clone of it (`<arms root>/clone`
 * under a marked arms root: the only tree an edit arm may edit).
 */

import { type ArmRepetition, type ArmsReport, captureArms, sequenceSteps } from '../../src/facets/perf/arms.js';
import { exactExit, MEASURABLE_SEQUENCES } from '../../src/harness/commands.js';
import type { SequenceStep } from '../../src/harness/sequence.js';
import type { ArmState } from '../../src/harness/types.js';
import { cloneAsPrepared } from '../arm-tree-fixtures.js';
import { tempDir } from '../integration/verdict-fixtures.js';

import { CANDIDATE_SOURCE, CANDIDATE_VAT, candidateSubject } from './candidate-subject.js';

/** The one build every arm here runs. */
const BUILD = 'b';

/** Rounds per invocation: few, so each file stays inside the system tier's budget. */
const ROUNDS = 3;

/** `ci-c`'s steps for {@link BUILD}, every step committed to exit 0. */
export const CI_C_STEPS: readonly SequenceStep[] = sequenceSteps(MEASURABLE_SEQUENCES['ci-c'], BUILD, []);

/**
 * A test-only sequence: `ci-c`, then a timed `git status` — exactly one more
 * git process per repetition than `ci-c`. Named without `+`: an arm name is a
 * directory-name segment.
 */
export const CI_C_STATUS = {
  arm: 'ci-c-status',
  steps: [
    ...CI_C_STEPS,
    {
      name: 'git-status',
      command: { kind: 'tool', command: 'git', args: ['status'] },
      timed: true,
      exit: exactExit(0),
      provenance: 'none',
      populates: false,
      writes: [],
    },
  ],
} as const satisfies { readonly arm: string; readonly steps: readonly SequenceStep[] };

/**
 * The candidate subject plus eight pages: twelve tracked files, ten of them
 * markdown with no frontmatter (the README, the guide and the pages).
 *
 * @returns The subject's root
 */
export function twelveFileSubject(): string {
  const pages = Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => [`docs/page-${String(index + 1)}.md`, `# Page ${String(index + 1)}\n\nSee [the guide](guide.md).\n`]),
  );
  return candidateSubject(pages);
}

/** Three pages nothing links to: a delete arm's `--edit`, so a deletion moves no finding. */
export const UNLINKED_PAGES = ['docs/page-1.md', 'docs/page-2.md', 'docs/page-3.md'] as const;

/**
 * One three-round invocation of the given arms of {@link BUILD}, in a
 * `git clone --local` of the subject at the arms root's prepared-clone path,
 * under the arm's git as `prepareClone` makes it ({@link cloneAsPrepared}).
 *
 * @param subject - The subject
 * @param arms - Each arm's name, state and steps
 * @param editPaths - `--edit`, or `null` for each edit arm's default candidates
 * @returns The report, and the clone the arms ran in
 */
export async function captureBuildArms(
  subject: string,
  arms: readonly { readonly arm: string; readonly state: ArmState; readonly steps: readonly SequenceStep[] }[],
  editPaths: readonly string[] | null,
): Promise<{ readonly report: ArmsReport; readonly clone: string }> {
  const armsRoot = tempDir('lab-edit-arms-');
  const clone = cloneAsPrepared(subject, armsRoot, tempDir('lab-edit-arms-git-'));
  const report = await captureArms({
    armsRoot,
    cwd: clone,
    builds: [{ alias: BUILD, source: CANDIDATE_SOURCE, instrument: CANDIDATE_VAT }],
    arms: arms.map((arm) => ({ build: BUILD, ...arm })),
    rounds: ROUNDS,
    env: { set: {}, unset: [] },
    editPaths,
  });
  return { report, clone };
}

/**
 * @param report - An arms report
 * @param arm - The arm's sequence name
 * @param state - Its state, spelled
 * @returns Its repetitions
 */
export function repetitionsOf(report: ArmsReport, arm: string, state: string): readonly ArmRepetition[] {
  const found = report.arms.find((each) => each.arm === arm && each.state === state);
  if (found === undefined) throw new Error(`${arm}:${state} is not in the report`);
  return found.repetitions;
}

/**
 * @param repetition - One repetition
 * @param name - A work counter
 * @returns Its count in the repetition's dump, or `undefined`
 */
export function counted(repetition: ArmRepetition, name: string): number | undefined {
  return repetition.work?.counters.find((reading) => reading.name === name)?.count;
}
