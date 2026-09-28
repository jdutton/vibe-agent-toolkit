/**
 * The verdict facet's subject set: a gitignored local file mapping an ALIAS to
 * a tree to measure, and which verbs to run on it.
 *
 * ## Why aliases, and why the file is local
 *
 * The subjects a crucible pass runs over are adopters' trees. Their names are
 * never committed anywhere — a subject is `crucible-1`, never who it is — so the
 * file that maps aliases to paths lives on the machine that runs the pass, and
 * `--subjects <file>` is REQUIRED with no default: a default path is a place
 * someone eventually commits by accident.
 *
 * ## Nothing the lab writes lands inside a subject
 *
 * VAT itself is a subject, so "inside a subject" includes this repository. The
 * subjects file, the `--out` directory, the per-arm projection store and the
 * build-verb clone all live outside every subject path; `capture.ts` refuses an
 * `--out` that does not.
 */

import { safePath } from '@vibe-agent-toolkit/utils';
import { z } from 'zod';

import { VERDICT_VERB_NAMES } from './verbs.js';
import { readYamlDocument, type Validated, validateDocument } from './yaml-file.js';

/** What a subjects document is, in a refusal. */
const SUBJECTS_FILE = 'a verdict subjects file';

/** One subject, as the file declares it. */
const VerdictSubjectSchema = z
  .object({
    alias: z.string().regex(/^[a-z0-9-]+$/, 'an alias is lowercase letters, digits and hyphens'),
    path: z.string().min(1),
    verbs: z.array(z.enum(VERDICT_VERB_NAMES)).min(1),
    /** Required iff `verbs` lists `context-path` — see the refinement below. */
    contextPath: z.string().min(1).optional(),
    sqlFiles: z.array(z.string().min(1)).default([]),
    /** Run `build` / `verify` / `claude marketplace publish --dry-run` in an APFS clone. */
    buildVerbs: z.boolean().default(false),
  })
  .strict()
  .superRefine((subject, ctx) => {
    const wantsPath = subject.verbs.includes('context-path');
    if (wantsPath === (subject.contextPath !== undefined)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contextPath'],
      message: wantsPath
        ? "'context-path' is listed, so contextPath must name the path it asks about"
        : "contextPath is set but 'context-path' is not listed — it would be silently unused",
    });
  })
  .superRefine((subject, ctx) => {
    const wantsQueries = subject.verbs.includes('resources-query');
    if (wantsQueries === subject.sqlFiles.length > 0) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sqlFiles'],
      message: wantsQueries
        ? "'resources-query' is listed, so sqlFiles must name at least one SQL file"
        : "sqlFiles is set but 'resources-query' is not listed — it would be silently unused",
    });
  });

/** The whole subjects file. */
export const VerdictSubjectsSchema = z
  .object({
    subjects: z.array(VerdictSubjectSchema).min(1),
  })
  .strict()
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    for (const [index, subject] of file.subjects.entries()) {
      if (seen.has(subject.alias)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['subjects', index, 'alias'],
          message: `alias '${subject.alias}' is declared twice — an alias is the key every stored report and every delta is filed under`,
        });
      }
      seen.add(subject.alias);
    }
  });

/** One parsed subject. */
export type VerdictSubject = z.infer<typeof VerdictSubjectSchema>;

/** A parsed subjects file. */
export type VerdictSubjects = z.infer<typeof VerdictSubjectsSchema>;

/** A parse that either produced subjects or says exactly why not. */
export type VerdictSubjectsResult =
  | { readonly ok: true; readonly subjects: VerdictSubjects }
  | { readonly ok: false; readonly refusal: string };

/**
 * Validate an already-read subjects document.
 *
 * Pure: no filesystem, so every rule is unit-testable. Paths are returned as
 * written; {@link loadVerdictSubjects} resolves them.
 *
 * @param value - The document's root value
 * @returns The subjects, or a refusal naming every issue
 */
export function parseVerdictSubjects(value: unknown): VerdictSubjectsResult {
  return asSubjects(validateDocument(VerdictSubjectsSchema, value, SUBJECTS_FILE));
}

/**
 * @param validated - A validated subjects document, or its refusal
 * @returns The same, keyed as {@link VerdictSubjectsResult}
 */
function asSubjects(validated: Validated<VerdictSubjects>): VerdictSubjectsResult {
  return validated.ok ? { ok: true, subjects: validated.value } : validated;
}

/** A loaded subjects file: every subject's `path` absolute, plus where SQL files resolve from. */
export type LoadedVerdictSubjects =
  | { readonly ok: true; readonly subjects: VerdictSubjects; readonly baseDir: string }
  | { readonly ok: false; readonly refusal: string };

/**
 * Read and validate a subjects file, resolving each subject's `path` against
 * the file's own directory — never the cwd, so one file means one set of trees
 * wherever `vat-lab` is run from.
 *
 * `sqlFiles` stay as written, because each one is also a row's LABEL
 * (`resources-query:<file>`) and an absolute path there would make a stored
 * report machine-specific; capture reads them against `baseDir`. `contextPath`
 * is left as written too: vat receives it with the subject as its cwd.
 *
 * @param file - Path to the YAML subjects file
 * @returns The subjects and the directory SQL files resolve from, or a refusal
 */
export function loadVerdictSubjects(file: string): LoadedVerdictSubjects {
  const parsed = asSubjects(readYamlDocument(file, VerdictSubjectsSchema, SUBJECTS_FILE));
  if (!parsed.ok) return parsed;
  const baseDir = safePath.resolve(file, '..');
  return {
    ok: true,
    baseDir,
    subjects: {
      subjects: parsed.subjects.subjects.map((subject) => ({
        ...subject,
        path: safePath.resolve(baseDir, subject.path),
      })),
    },
  };
}
