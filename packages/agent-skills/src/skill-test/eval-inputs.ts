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

// evals.json is adopter-authored input that VAT *reads* — so per the project's
// Postel's Law (read the outside world liberally), we validate only the fields
// VAT actually consumes and pass everything else through untouched. `id` accepts
// a string OR an int: skill-creator's methodology encourages *descriptive* eval
// identifiers, and real adopter suites (e.g. dxa) use descriptive string ids plus
// adopter-owned metadata like `category` / top-level `_category_note`. The
// load-bearing fields stay required, so a typo in one is still caught.
export const EvalEntrySchema = z
  .object({
    id: z.union([z.number().int(), z.string().min(1)]),
    prompt: z.string().min(1),
    expected_output: z.string().min(1),
    files: z.array(z.string().min(1)).optional(),
    expectations: z.array(z.string().min(1)).min(1),
  })
  .passthrough();

export const EvalSuiteSchema = z
  .object({
    _comment: z.array(z.string()).optional(),
    skill_name: z.string().min(1),
    evals: z.array(EvalEntrySchema).min(1),
  })
  .passthrough();

export type EvalEntry = z.infer<typeof EvalEntrySchema>;
export type EvalSuite = z.infer<typeof EvalSuiteSchema>;

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
  const ids = result.data.evals.map((e) => e.id);
  if (new Set(ids).size !== ids.length) {
    throw new EvalInputError('eval ids must be unique within a suite');
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
      try {
        const src = safePath.joinUnderRoot(input.evalsDir, rel);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- src is contained under evalsDir via joinUnderRoot; suite is developer-authored
        if (!existsSync(src)) {
          throw new EvalInputError(`eval ${entry.id} declares input file "${rel}" but it is absent at ${src}`);
        }
        const dest = safePath.joinUnderRoot(evalWorkspace, rel);
        mkdirSyncReal(safePath.join(dest, '..'), { recursive: true });
        cpSync(src, dest, { recursive: true });
      } catch (err) {
        if (err instanceof EvalInputError) throw err;
        throw new EvalInputError(
          `eval ${entry.id} declares input file "${rel}" that escapes the eval directory: ${(err as Error).message}`,
        );
      }
    }
  }
  return input.workspacesRoot;
}
