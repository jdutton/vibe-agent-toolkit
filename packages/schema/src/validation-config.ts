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
 * Numeric knobs a project may move for checks whose finding is "over a limit"
 * rather than "wrong".
 *
 * There is no top-level `validation:` key in `vibe-agent-toolkit.config.yaml`:
 * `ValidationConfigSchema` is mounted at `resources.validation` and, per skill,
 * at `skills.config.<name>.validation`. So the adopter-facing path for a knob
 * added here is `resources.validation.thresholds.<name>` — spell it that way in
 * any `fix` string, because a hint naming a config path that does not exist is
 * worse than no hint.
 *
 * NOTE THE ABSENCE OF DEFAULTS HERE, and do not add them. The default value for
 * `alwaysLoadedContextTokens` lives beside the detector that uses it, in
 * `packages/resources/src/projection/claude-context-budget.ts`
 * (`DEFAULT_ALWAYS_LOADED_CONTEXT_TOKENS`), not in this file — for two reasons:
 *
 *  1. The default check set is a property of the PIPELINE, not of the config
 *     file. A directory with no `vibe-agent-toolkit.config.yaml` must run
 *     exactly the same default-on checks, at exactly the same thresholds, as one
 *     with a config. Config only ever *overrides*. A default expressed as a Zod
 *     `.default()` would be reachable only through a parse, so the no-config
 *     path would silently get a different (or absent) number.
 *  2. `packages/schema` must not depend on `packages/resources` — the dependency
 *     runs the other way. So the constant cannot be imported here even to keep
 *     the two in sync, and a duplicated literal is worse than a documented
 *     pointer: it is a second source of truth that nothing compares.
 *
 * Every field is therefore optional with no default, and `undefined` means
 * "the caller's own default applies", never "zero" or "off".
 */
export interface ValidationThresholds {
  /**
   * Token budget for a working directory's always-loaded context. Reported
   * against by `ALWAYS_LOADED_CONTEXT_BUDGET`. Adopter-facing path:
   * `resources.validation.thresholds.alwaysLoadedContextTokens`. Default: see
   * `DEFAULT_ALWAYS_LOADED_CONTEXT_TOKENS` in `packages/resources`.
   */
  alwaysLoadedContextTokens?: number | undefined;
}

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
  thresholds?: ValidationThresholds | undefined;
}

// The `unknown` INPUT parameter is deliberate, not a leftover from satisfying the
// compiler. This schema's job is to validate a `validation:` block parsed out of a
// YAML file, which is `unknown` by construction — a caller that already had a
// typed value would have no reason to parse it. Typing the input narrower would
// only let a caller skip the check the schema exists to perform.
export const ValidationConfigSchema: z.ZodType<ValidationConfig, z.ZodTypeDef, unknown> = z.object({
  severity: z.record(IssueCodeSchema, SeverityLevelSchema).optional(),
  allow: z.record(IssueCodeSchema, z.array(AllowEntrySchema)).optional(),
  // `.strict()` on the inner object as well as the outer one: a mistyped
  // threshold name is the failure this block is most likely to see, and a
  // passthrough object would accept `alwaysLoadedContextTokenz: 40000` and then
  // silently apply the built-in default, which reads as "the knob does nothing".
  thresholds: z.object({
    alwaysLoadedContextTokens: z.number().int().positive().optional(),
  }).strict().optional(),
}).strict();
