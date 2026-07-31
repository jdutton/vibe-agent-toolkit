import { cpSync, existsSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { z } from 'zod';

/** Raised for any eval-input problem (bad JSON, schema failure, missing input file). Maps to exit 2. */
export class EvalInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalInputError';
  }
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
    for (const key of Object.keys(entry)) {
      if ((RECOGNIZED_EVAL_FIELDS as readonly string[]).includes(key)) continue;
      const near = RECOGNIZED_EVAL_FIELDS.find((field) => isSingleEditAway(key.toLowerCase(), field.toLowerCase()));
      if (near !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `unknown eval field "${key}" — did you mean "${near}"? (other custom fields are allowed and ignored)`,
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
    throw new EvalInputError(`evals.json is not valid JSON: ${(e as Error).message}`);
  }
  const result = EvalSuiteSchema.safeParse(raw);
  if (!result.success) {
    throw new EvalInputError(`evals.json failed schema validation: ${result.error.message}`);
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

export interface StageEvalWorkspacesInput {
  /** Parsed suite (Task 1). */
  suite: EvalSuite;
  /** Directory containing evals.json — the base for each eval's relative `files`. */
  evalsDir: string;
  /** `<harnessRoot>/workspaces` — per-eval dirs are created beneath it. */
  workspacesRoot: string;
}

/**
 * Materialize each eval's declared input `files` into `<workspacesRoot>/<id>/<relpath>`,
 * preserving relative structure. Evals without `files` are skipped. Throws
 * {@link EvalInputError} if a listed file does not exist (the eval cannot run without it).
 * Returns `workspacesRoot`.
 */
export function stageEvalWorkspaces(input: StageEvalWorkspacesInput): string {
  for (const entry of input.suite.evals) {
    if (entry.files === undefined || entry.files.length === 0) continue;
    const evalWorkspace = safePath.joinUnderRoot(input.workspacesRoot, String(entry.id));
    for (const rel of entry.files) {
      // Containment first: a `rel` that escapes evalsDir or the workspace is a
      // genuine "escapes the eval directory" problem and is reported as such.
      let src: string;
      let dest: string;
      try {
        src = safePath.joinUnderRoot(input.evalsDir, rel);
        dest = safePath.joinUnderRoot(evalWorkspace, rel);
      } catch (err) {
        throw new EvalInputError(
          `eval ${entry.id} declares input file "${rel}" that escapes the eval directory: ${(err as Error).message}`,
        );
      }
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- src is contained under evalsDir via joinUnderRoot; suite is developer-authored
      if (!existsSync(src)) {
        throw new EvalInputError(`eval ${entry.id} declares input file "${rel}" but it is absent at ${src}`);
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
          `eval ${entry.id} failed to stage input file "${rel}" into the workspace: ${(err as Error).message}`,
        );
      }
    }
  }
  return input.workspacesRoot;
}
