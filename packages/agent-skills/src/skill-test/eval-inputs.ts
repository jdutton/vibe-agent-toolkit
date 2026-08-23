import { cpSync, existsSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { z } from 'zod';

import { sanitizeGraderText, sanitizeTextPreservingLines } from './grader-text.js';

/** Raised for any eval-input problem (bad JSON, schema failure, missing input file). Maps to exit 2. */
export class EvalInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalInputError';
  }
}

/**
 * Neutralize a SUITE-AUTHORED string before it is quoted into an
 * {@link EvalInputError}, whose message reaches `process.stdout` on the
 * `Summary:` line — the one channel deliberately kept machine-readable — and
 * renders twice on the way there.
 *
 * The suite is nominally adopter-authored, but `resolveEvalSuitePath` will
 * harvest one out of a FETCHED npm/url artifact, i.e. out of the skill under
 * test, so treat it as untrusted. `files[]` is the sharp edge: it is
 * `z.array(z.string().min(1))` with NO charset constraint, in deliberate
 * contrast to `id`, which is regex-pinned precisely because it names a
 * directory. A derived path or an OS error text built from such an entry
 * carries the same bytes, so those are sanitized here too, not just the entry.
 *
 * Reuses {@link sanitizeGraderText} rather than growing a second neutralizer:
 * the threat and the remedy (drop escape sequences whole, fold every remaining
 * control code to a space, collapse, cap) are identical — only the source of
 * the untrusted text differs.
 */
function quoteSuiteText(value: string): string {
  return sanitizeGraderText(value);
}

/**
 * The same neutralization for a suite-derived string that is ALREADY multi-line
 * and whose lines carry the meaning — today, exactly one: zod's schema-failure
 * text.
 *
 * That message is a list of issues, one per offending path, and every one of the
 * paths in it is a SUITE-AUTHORED KEY (`evals[17].toolExpecations`) reaching
 * stderr unsanitized. It cannot go through {@link quoteSuiteText}: that collapses
 * the list onto one capped line, which is the difference between "your suite has
 * a typo, here is where" and "your suite has a typo". Degrading the common case to
 * neutralize the rare one is a bad trade, so the sanitizer that keeps lines is
 * used instead. See {@link sanitizeTextPreservingLines} for why it is not the
 * default anywhere else.
 */
function quoteSuiteBlock(value: string): string {
  return sanitizeTextPreservingLines(value);
}

/**
 * String eval ids name a per-eval working directory ({@link stageEvalWorkspaces}),
 * so they must be safe path segments on every platform. Letters, digits, hyphen,
 * and underscore only — this rejects `/`, `\`, `:`, spaces, `..`, and other
 * filesystem-illegal characters that would otherwise fail (or behave
 * inconsistently) on Windows. Descriptive adopter ids like `dollar-quote-recovery`
 * pass unchanged; `year:extraction` is rejected at parse with a clear message
 * instead of failing later as an opaque copy/escape error.
 */
const EVAL_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Fields VAT recognizes per eval. Unknown fields are allowed (passthrough); a
 *  near-miss of one of these is flagged as a likely typo (see superRefine). */
const RECOGNIZED_EVAL_FIELDS = [
  'id',
  'prompt',
  'expected_output',
  'files',
  'expectations',
  'tier',
  'toolExpectations',
] as const;

/**
 * True when `key` is exactly one edit (insert/delete/substitute one char) from
 * `target`. Used to catch typos of recognized fields (here) and of declared
 * executable names ({@link ./eval-lint.ts}) — deliberately a tiny single-edit
 * check, not a general edit-distance routine, so it stays cheap and never fires
 * on legitimately distinct adopter strings (`name`, `category`, `notes`).
 */
export function isSingleEditAway(key: string, target: string): boolean {
  if (key === target) return false;
  const lk = key.length;
  const lt = target.length;
  if (Math.abs(lk - lt) > 1) return false;
  let i = 0;
  while (i < lk && i < lt && key[i] === target[i]) i++;
  if (lk === lt) return key.slice(i + 1) === target.slice(i + 1); // substitution
  if (lk > lt) return key.slice(i + 1) === target.slice(i); // deletion from key
  return key.slice(i) === target.slice(i + 1); // insertion into key
}

/**
 * Reject an expectation string an eval declares TWICE.
 *
 * The entry, not the text, is the unit every reported score counts:
 * `runGraderForEval`'s declared-vs-graded check compares `fragment.expectations`
 * against `expectations.length`, and each arm's summary and the `--baseline` delta
 * are computed over those entries. A suite that declares the same string twice
 * hands the grader "1. x / 2. x" and gets ONE entry back for it — a perfectly
 * reasonable grader response, and one that fails the count check mid-run with an
 * `InternalHarnessError`, destroying a fully-billed treatment run over an input
 * defect nothing looked at.
 *
 * So it is caught at PARSE, exactly like the duplicate-id rule in
 * {@link parseEvalSuite}: exit 2, user-correctable, before anything is spawned.
 * Scoped to one eval — two different evals may legitimately share expectation
 * text, since each is graded from its own transcript.
 *
 * `expectations` is `z.array(z.string().min(1))` with no charset constraint and
 * the message reaches stdout, so the offending string is sanitized on the way in.
 */
function addDuplicateExpectationIssues(expectations: string[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const [index, expectation] of expectations.entries()) {
    if (!seen.has(expectation)) {
      seen.add(expectation);
      continue;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `duplicate expectation "${quoteSuiteText(expectation)}" — an eval must declare each expectation ` +
        'once. Every reported score counts fragment ENTRIES, and a grader handed the same text twice ' +
        'returns one entry for it, which fails the declared-count check mid-run.',
      path: ['expectations', index],
    });
  }
}

// evals.json is adopter-authored input that VAT *reads* — so per the project's
// Postel's Law (read the outside world liberally), we validate only the fields
// VAT actually consumes and pass everything else through untouched. `id` accepts
// a string OR an int: skill-creator's methodology encourages *descriptive* eval
// identifiers, and real adopter suites use descriptive string ids plus
// adopter-owned metadata like `category` / top-level `_category_note`. The
// load-bearing fields stay required, so a typo in a REQUIRED field is caught by
// its absence; a near-miss typo of the OPTIONAL `files` field (which would
// otherwise be silently swallowed by passthrough) is caught by the superRefine.
export const EvalEntrySchema = z
  .object({
    id: z.union([
      z.number().int(),
      z
        .string()
        .min(1)
        .regex(
          EVAL_ID_PATTERN,
          'string eval id must contain only letters, digits, hyphen, or underscore (it names a working directory)',
        ),
    ]),
    prompt: z.string().min(1),
    // Optional: a human-readable success description. The pass/fail verdict is
    // always decided per `expectations` entry, so this is not load-bearing and
    // (per Postel's Law) is not required — real adopter suites routinely
    // grade with `expectations` alone. When present, the grader prompt feeds it
    // to the grader as prose CONTEXT informing judgment (see grader-prompt.ts).
    expected_output: z.string().min(1).optional(),
    files: z.array(z.string().min(1)).optional(),
    expectations: z.array(z.string().min(1)).min(1),
    // Cost/foundational tier for fail-fast gating (Phase G): ascending, 0 = cheapest/first.
    // Optional — adopters who don't opt into tiered execution omit it.
    tier: z.number().int().nonnegative().optional(),
    // Which tools SHOULD/SHOULD-NOT run, judged later by the grader against the
    // transcript (Phase T). This sub-object's keys are VAT-defined (not adopter-owned
    // like the entry itself), so it is `.strict()` — a typo here is a hard schema error,
    // not silently passed through.
    toolExpectations: z
      .object({
        mustRun: z.array(z.string().min(1)).optional(),
        mustNotRun: z.array(z.string().min(1)).optional(),
        // Each named executable must have RUN and its invoking tool_result must
        // NOT be an error (feature #148). Judged from the transcript by the
        // grader — see tool-eval-schema.ts's ToolSucceedCheckSchema.
        mustSucceed: z.array(z.string().min(1)).optional(),
        sequence: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
  })
  .passthrough()
  .superRefine((entry, ctx) => {
    addDuplicateExpectationIssues(entry.expectations, ctx);
    for (const key of Object.keys(entry)) {
      if ((RECOGNIZED_EVAL_FIELDS as readonly string[]).includes(key)) continue;
      const near = RECOGNIZED_EVAL_FIELDS.find((field) => isSingleEditAway(key.toLowerCase(), field.toLowerCase()));
      if (near !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          // `key` is a suite-authored object key with no charset constraint, and
          // this message is surfaced through `result.error.message` below.
          message: `unknown eval field "${quoteSuiteText(key)}" — did you mean "${near}"? (other custom fields are allowed and ignored)`,
          path: [key],
        });
      }
    }
  });

export const EvalSuiteSchema = z
  .object({
    _comment: z.array(z.string()).optional(),
    skill_name: z.string().min(1),
    evals: z.array(EvalEntrySchema).min(1),
  })
  .passthrough();

export type EvalEntry = z.infer<typeof EvalEntrySchema>;
export type EvalSuite = z.infer<typeof EvalSuiteSchema>;

/**
 * The declared tool expectations of ONE eval (issue #145 Phase T). Derived from
 * {@link EvalEntry} so the grader input + prompt builder share the EXACT shape the
 * parser produces — no drift, and no duplicated inline `{ mustRun?; mustNotRun?;
 * sequence? }` literal across those consumers.
 */
export type ToolExpectations = NonNullable<EvalEntry['toolExpectations']>;

/** Parse + validate a skill-test eval suite. Throws {@link EvalInputError} on any problem. */
export function parseEvalSuite(jsonText: string): EvalSuite {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (e) {
    // V8 quotes a verbatim, unescaped slice of the offending bytes into its
    // SyntaxError message — a suite file that is nothing but ANSI escapes would
    // otherwise repaint the operator's terminal from vat's own error line.
    throw new EvalInputError(`evals.json is not valid JSON: ${quoteSuiteText((e as Error).message)}`);
  }
  const result = EvalSuiteSchema.safeParse(raw);
  if (!result.success) {
    throw new EvalInputError(`evals.json failed schema validation: ${quoteSuiteBlock(result.error.message)}`);
  }
  // Compare ids as strings: each id names a working directory via String(id),
  // so a numeric `1` and a string `"1"` would collide on disk even though they
  // are distinct JS values. Dedup on the stringified form to catch that.
  const ids = result.data.evals.map((e) => String(e.id));
  if (new Set(ids).size !== ids.length) {
    throw new EvalInputError('eval ids must be unique within a suite (ids are compared as strings, so 1 and "1" collide)');
  }
  return result.data;
}

/**
 * One side of a `--baseline` A/B: `'with'` runs the skill staged and declared,
 * `'without'` is the control. Declared here rather than in the run orchestrator
 * because the staging layer needs it to give each arm its own workspace tree.
 */
export type EvalArm = 'with' | 'without';

/**
 * The opaque directory segment each arm's workspaces live under, minted fresh per
 * run. `with` is required and `without` present only under `--baseline`, so the
 * set of arms is the keys — a shape that cannot express "stage nothing", unlike
 * the `readonly EvalArm[]` this replaced (an empty array was a legal input that
 * silently left every executor with a non-existent cwd).
 *
 * ⚠️ The VALUES must not be the literal arm names, and must not be derivable from
 * each other. See {@link stageEvalWorkspaces}.
 */
export interface ArmWorkspaceDirs {
  with: string;
  without?: string;
}

/** The arms an {@link ArmWorkspaceDirs} covers, in dispatch order. */
export function armsOf(dirs: ArmWorkspaceDirs): readonly EvalArm[] {
  return dirs.without === undefined ? (['with'] as const) : (['with', 'without'] as const);
}

/**
 * The directory segment for one arm. Throws rather than falling back to the arm
 * NAME: a silent fallback would reinstate the unblinding this indirection exists
 * to remove, and would do it invisibly.
 */
export function armDirSegment(dirs: ArmWorkspaceDirs, arm: EvalArm): string {
  const segment = arm === 'with' ? dirs.with : dirs.without;
  if (segment === undefined || segment === '') {
    throw new EvalInputError(
      `Internal: no workspace directory was minted for the "${arm}" arm. ` +
        'Every arm this run dispatches must have one; falling back to the arm name would ' +
        'tell the executor which side of the A/B it is on.',
    );
  }
  return segment;
}

export interface StageEvalWorkspacesInput {
  /** Parsed suite (Task 1). */
  suite: EvalSuite;
  /** Directory containing evals.json — the base for each eval's relative `files`. */
  evalsDir: string;
  /** Per-run workspaces root — per-arm, per-eval dirs are created beneath it. */
  workspacesRoot: string;
  /**
   * Opaque per-arm directory segments. Each arm gets its OWN copy of every
   * workspace; see the note on the layout below for why that is not an
   * optimization to undo.
   */
  armDirs: ArmWorkspaceDirs;
}

/**
 * Materialize each eval's declared input `files` into
 * `<workspacesRoot>/<armDir>/<id>/<relpath>`, preserving relative structure. Throws
 * {@link EvalInputError} if a listed file does not exist (the eval cannot run
 * without it). Returns `workspacesRoot`.
 *
 * EVERY eval gets a directory, including one that declares no `files` — it is
 * simply left empty. An eval without a workspace used to leave the executor with
 * no cwd of its own, so it ran inside the staged subject dir instead; for the
 * skill-absent arm of a `--baseline` run that placed the control's cwd inside the
 * very skill the arm exists to withhold. An empty dir costs nothing and keeps cwd
 * shaped identically across both arms, which is what makes the A/B a comparison.
 *
 * WHY THE `<arm>` SEGMENT. The two arms of one eval are dispatched ADJACENTLY into
 * a bounded-parallel pool, so they run at the same time. When they shared one
 * directory, the control arm could simply `ls` and read whatever the treatment arm
 * had just written — recovering the treatment's answer without ever touching the
 * skill, and without producing a single detectable harness path. That is a channel
 * BETWEEN the arms rather than into one of them, which is why auditing the four
 * channels into a process (prompt, argv, cwd, env) did not surface it: each arm's
 * own cwd was correct in isolation, and wrong as a pair. The arms must be
 * byte-identical at start and unable to observe each other after it.
 *
 * WHY THE SEGMENT IS AN OPAQUE TOKEN and not the arm's name. It used to be the
 * literal `with`/`without`, which made the executor's own working directory the
 * loudest possible unblinding: the prompt tells each arm `Your working directory
 * is …/vat-skill-test-ws-<token>/without/e1`, so the skill-absent arm was told, in
 * the one string it cannot avoid reading, which side of the experiment it was on —
 * while `buildExecutorPrompt`'s docblock promises it "must NEVER be told (directly
 * or by implication) that it is being tested, evaluated, or graded". It also named
 * the sibling: `../with/<id>/` was a guessable path to the treatment arm's live
 * output. Independent random tokens fix both, and cost nothing.
 */
export function stageEvalWorkspaces(input: StageEvalWorkspacesInput): string {
  for (const arm of armsOf(input.armDirs)) {
    stageEvalWorkspacesForArm(input, arm);
  }
  return input.workspacesRoot;
}

function stageEvalWorkspacesForArm(input: StageEvalWorkspacesInput, arm: EvalArm): void {
  const armRoot = safePath.joinUnderRoot(input.workspacesRoot, armDirSegment(input.armDirs, arm));
  mkdirSyncReal(armRoot, { recursive: true, mode: 0o700 });
  for (const entry of input.suite.evals) {
    const evalWorkspace = safePath.joinUnderRoot(armRoot, String(entry.id));
    // 0700 like the root above it — created for every eval, populated only by
    // those declaring `files`.
    mkdirSyncReal(evalWorkspace, { recursive: true, mode: 0o700 });
    for (const rel of entry.files ?? []) {
      // Containment first: a `rel` that escapes evalsDir or the workspace is a
      // genuine "escapes the eval directory" problem and is reported as such.
      let src: string;
      let dest: string;
      try {
        src = safePath.joinUnderRoot(input.evalsDir, rel);
        dest = safePath.joinUnderRoot(evalWorkspace, rel);
      } catch (err) {
        throw new EvalInputError(
          `eval ${entry.id} declares input file "${quoteSuiteText(rel)}" that escapes the eval directory: ` +
            quoteSuiteText((err as Error).message),
        );
      }
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- src is contained under evalsDir via joinUnderRoot; suite is developer-authored
      if (!existsSync(src)) {
        throw new EvalInputError(
          `eval ${entry.id} declares input file "${quoteSuiteText(rel)}" but it is absent at ${quoteSuiteText(src)}`,
        );
      }
      // Copy failures (permissions, illegal filename on the host, disk) are
      // reported accurately rather than mislabeled as a containment escape.
      try {
        // 0700 like the workspaces root above it: with an out-of-tree suite these
        // hold data that may never have been in the repo.
        mkdirSyncReal(safePath.join(dest, '..'), { recursive: true, mode: 0o700 });
        cpSync(src, dest, { recursive: true });
      } catch (err) {
        throw new EvalInputError(
          `eval ${entry.id} failed to stage input file "${quoteSuiteText(rel)}" into the workspace: ` +
            quoteSuiteText((err as Error).message),
        );
      }
    }
  }
}
