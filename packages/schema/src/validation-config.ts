import { z } from 'zod';

import { IssueCodeSchema, type IssueCode } from './validation-codes.js';

export const SeverityLevelSchema = z.enum(['error', 'warning', 'info', 'ignore']);
export type SeverityLevel = z.infer<typeof SeverityLevelSchema>;

export const AllowEntrySchema = z.object({
  paths: z.array(z.string().min(1)).min(1).default(['**/*']),
  reason: z.string().min(1),
  expires: z.string().optional(),
}).strict();
export type AllowEntry = z.infer<typeof AllowEntrySchema>;

/**
 * Written out rather than inferred, and the schema below is annotated with it.
 *
 * `z.record(IssueCodeSchema, …)` inlines the ENTIRE code-name union into the
 * inferred type — twice, once per field. Every downstream `.d.ts` that mentions
 * this schema then carries both copies verbatim: `project-config.d.ts` emitted
 * two ~2.5 KB single-line types for it. Past a certain width TypeScript's
 * declaration printer starts attaching leading JSDoc to the wrong node and emits
 * syntactically invalid `.d.ts` — observed as
 * `paths: z.ZodDefault /** …a comment from an unrelated declaration… *\/<z.ZodArray<…>>;`,
 * which then fails every package that consumes it (1341 errors from one file).
 *
 * Adding two codes was enough to cross that line, so the inlining is the defect,
 * not the codes. Annotating collapses both copies to a named `IssueCode`
 * reference, which keeps the emitted declarations small no matter how long the
 * registry grows — and stops the next person who adds a code from hitting this.
 *
 * Runtime behaviour is unchanged: the value is still the same strict `ZodObject`,
 * so `safeParse` still rejects unknown codes and unknown top-level keys, and
 * `zod-to-json-schema` still walks the real schema when generating
 * `schemas/validation-config.json`.
 */
// The explicit `| undefined` is required by `exactOptionalPropertyTypes`, which
// this repo enables: Zod infers an optional field as `T | undefined`, and without
// the union the annotation is narrower than the schema it describes.
export interface ValidationConfig {
  severity?: Partial<Record<IssueCode, SeverityLevel>> | undefined;
  allow?: Partial<Record<IssueCode, AllowEntry[]>> | undefined;
}

// The `unknown` INPUT parameter is deliberate, not a leftover from satisfying the
// compiler. This schema's job is to validate a `validation:` block parsed out of a
// YAML file, which is `unknown` by construction — a caller that already had a
// typed value would have no reason to parse it. Typing the input narrower would
// only let a caller skip the check the schema exists to perform.
export const ValidationConfigSchema: z.ZodType<ValidationConfig, z.ZodTypeDef, unknown> = z.object({
  severity: z.record(IssueCodeSchema, SeverityLevelSchema).optional(),
  allow: z.record(IssueCodeSchema, z.array(AllowEntrySchema)).optional(),
}).strict();
