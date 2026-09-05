import { z } from 'zod';

import { IssueCodeSchema, type IssueCode } from './validation-codes.js';
import { isCustomCheckCode, type CustomCheckCode } from './validation-issue.js';

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
  severity?: Partial<Record<IssueCode | CustomCheckCode, SeverityLevel>> | undefined;
  allow?: Partial<Record<IssueCode, AllowEntry[]>> | undefined;
  thresholds?: ValidationThresholds | undefined;
}

/**
 * The key space of `validation.severity`: every shipped registry code, **plus**
 * the `CUSTOM:<name>` namespace `resources.checks` mints.
 *
 * ## Why this is a union and not the enum, and not `z.string()` either
 *
 * The enum alone was a shipped defect of the worst kind — following our own
 * documentation bricked every command. `vat resources check --help`, the
 * `resources.checks` schema description and `sql-checks.ts` all told adopters
 * that `resources.validation.severity` could downgrade or ignore an inherited
 * check. Zod parses record KEYS through the key schema, so `CUSTOM:my-check` was
 * an `invalid_enum_value`; that failed `ProjectConfigSchema`, which failed
 * `loadConfig`, which every command calls. The user's reward for doing what
 * three docs told them was `exit 2` and a dump of the ~150-entry registry enum,
 * on `vat resources scan` as readily as on `check`.
 *
 * `z.string()` would fix that and give back a worse thing: the enum branch is
 * why a misspelled registry code (`LNIK_OUTSIDE_PROJECT`) is refused instead of
 * silently overriding nothing, and it is what `zod-to-json-schema` emits as an
 * `enum` for editor completion. So the accept set widens by exactly one closed
 * namespace, and {@link isCustomCheckCode} — the acceptor that lives beside the
 * minter — is the only thing that decides membership in it.
 *
 * ⚠️ `ValidationConfigSchema` is mounted at `resources.validation` **and** at
 * `skills.config.<name>.validation`, so a `CUSTOM:` key parses under the skills
 * mount too, where no check runs and it does nothing. Accepted rather than
 * split: one key space with an inert corner is a smaller lie than two schemas
 * that can disagree about what a code is, and the field name there names a skill
 * the adopter is already looking at.
 */
/**
 * A key shaped like a shipped registry code — `SCREAMING_SNAKE_CASE`.
 *
 * Derived from the SHAPE rather than listed, so it cannot fall behind the
 * registry or behind `NonOverridableCode`. It exists only to tell two refusals
 * apart in the MESSAGE; membership decisions still belong to `IssueCodeSchema`
 * and {@link isCustomCheckCode}.
 */
const REGISTRY_SHAPED_KEY = /^[A-Z][\dA-Z_]*$/;

/**
 * Explain a `severity` key this schema will not take.
 *
 * 🪤 **Two refusals, and conflating them sent half the readers to the wrong
 * place.** The message used to be one sentence for every rejected key: *"a
 * custom severity key must be `CUSTOM:<name>`, naming a check declared under
 * resources.checks"*. An adopter who wrote `RESOURCE_CHECK_BROKEN: ignore` —
 * having read three docs that describe it at length — was told they had
 * misspelled a *custom* key, which is not what happened and not what to do
 * about it. A registry-shaped key that is not in the registry is either a typo
 * or a code that is deliberately unsilenceable, and both readings are worth
 * more than a sentence about `CUSTOM:`.
 *
 * ⛔ **It no longer claims the name must be DECLARED.** The old wording ended
 * "naming a check declared under resources.checks" and nothing enforced it —
 * {@link isCustomCheckCode} tests the prefix and nothing else, so
 * `CUSTOM:a-check-that-does-not-exist` parsed, overrode nothing, and said
 * nothing. Enforcing it here is impossible (this schema cannot see
 * `resources.checks`) and enforcing it at the parent would be a new breaking
 * refusal, so the check moved to a run-time WARNING in
 * `vat resources check` — see `warnUndeclaredOverrides` there. A message must
 * not promise a guard that does not exist: an adopter who believes a stale
 * override would be refused stops looking for one.
 *
 * @param code - The rejected key
 * @returns What to tell the adopter
 */
function severityKeyRefusal(code: string): string {
  if (REGISTRY_SHAPED_KEY.test(code)) {
    return `\`${code}\` is not a severity key this config accepts. Either it is a misspelled`
      + ' registry code, or it is one of the codes deliberately kept outside the override'
      + ' framework — `RESOURCE_CHECK_BROKEN` among them, which reports that a declared check'
      + ' STOPPED RUNNING and is unsilenceable by construction so a renamed column cannot end a'
      + ' gate quietly. You can downgrade or ignore a check with `CUSTOM:<its-name>`; you cannot'
      + ' downgrade the news that it stopped checking.';
  }
  return 'a custom severity key must be spelled `CUSTOM:<name>`, where `<name>` is a check\'s key'
    + ' under resources.checks';
}

export const SeverityOverrideCodeSchema = z.union([
  IssueCodeSchema,
  z.string().superRefine((code, ctx) => {
    if (isCustomCheckCode(code)) return;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: severityKeyRefusal(code) });
  }),
]);

// The `unknown` INPUT parameter is deliberate, not a leftover from satisfying the
// compiler. This schema's job is to validate a `validation:` block parsed out of a
// YAML file, which is `unknown` by construction — a caller that already had a
// typed value would have no reason to parse it. Typing the input narrower would
// only let a caller skip the check the schema exists to perform.
export const ValidationConfigSchema: z.ZodType<ValidationConfig, z.ZodTypeDef, unknown> = z.object({
  severity: z.record(SeverityOverrideCodeSchema, SeverityLevelSchema).optional(),
  // 🔑 `allow` stays keyed by the REGISTRY enum, and the asymmetry with
  // `severity` above is the decision, not an oversight. `severity` reaches a
  // check's findings for real: `resolveIssueSeverity` is code-agnostic and
  // `vat resources check` calls it. The allow filter is `IssueCode`-typed and
  // that command never runs it, so a `CUSTOM:` allow entry would parse, exempt
  // nothing, and report nothing — the adopter would believe a path was excused
  // while every finding under it still failed their build. A loud config error
  // is the honest answer until the check lane actually runs the allow filter.
  allow: z.record(IssueCodeSchema, z.array(AllowEntrySchema)).optional(),
  // `.strict()` on the inner object as well as the outer one: a mistyped
  // threshold name is the failure this block is most likely to see, and a
  // passthrough object would accept `alwaysLoadedContextTokenz: 40000` and then
  // silently apply the built-in default, which reads as "the knob does nothing".
  thresholds: z.object({
    alwaysLoadedContextTokens: z.number().int().positive().optional(),
  }).strict().optional(),
}).strict();
