import { z } from 'zod';

import { escapeRegExpLiteral } from './regexp-escape.js';
import { FindingCodeSchema, IssueSeveritySchema, RefusalCodeSchema, type FindingCode, type IssueSeverity } from './validation-codes.js';
import { CUSTOM_CHECK_CODE_PATTERN_SOURCE, type CustomCheckCode } from './validation-issue.js';


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
//
// Keyed by `FindingCode`, not every registered code: a refusal-kind code (the
// run could not do its job) is never a config key — see `severityKeyRefusal`.
export interface ValidationConfig {
  severity?: Partial<Record<FindingCode | CustomCheckCode, IssueSeverity>> | undefined;
  allow?: Partial<Record<FindingCode, AllowEntry[]>> | undefined;
}

/**
 * The key space of `validation.severity`: every shipped FINDING-kind registry
 * code, **plus** the `CUSTOM:<name>` namespace `resources.checks` mints. A
 * refusal-kind code is not in it: a refusal reports that the run could not do
 * its job, and that has no legitimate `ignore`.
 *
 * ## Why this is not the enum, and not a bare `z.string()` either
 *
 * The enum alone was a shipped defect of the worst kind — following our own
 * documentation bricked every command. `vat resources check --help`, the
 * `resources.checks` schema description and `sql-checks.ts` all told adopters
 * that `resources.validation.severity` could downgrade or ignore an inherited
 * check. Zod parses record KEYS through the key schema, so `CUSTOM:my-check` was
 * an `invalid_enum_value`; that failed `ProjectConfigSchema`, which failed
 * `loadConfig`, which every config-reading command calls. The user's reward for doing what
 * three docs told them was `exit 2` and a dump of the ~150-entry registry enum,
 * on `vat resources scan` as readily as on `check`.
 *
 * `z.string()` would fix that and give back a worse thing: enumerating the
 * registry codes is why a misspelled one (`LNIK_OUTSIDE_PROJECT`) is refused
 * instead of silently overriding nothing. So the accept set widens by exactly
 * one closed namespace — {@link CUSTOM_CHECK_CODE_PATTERN_SOURCE}, the rule that
 * lives beside the minter, is the only thing that decides membership in it.
 *
 * ## Why one PATTERN and not a `z.union([enum, custom])`
 *
 * 🪤 **A union key emits nothing.** This was a union for one release, and
 * `zod-to-json-schema`'s record parser has cases for a `ZodEnum` key and for a
 * `ZodString` key carrying checks — and none for a `ZodUnion`. So the shipped
 * `schemas/validation-config.json` lost its `severity` key constraint entirely
 * while `allow`, in the same file, kept its full enum: an adopter's editor
 * accepted `LNIK_OUTSIDE_PROJECT: ignore`, offered no completion, and
 * `loadConfig` then refused it. The runtime was never wrong, which is exactly
 * why nothing caught it — see `test/emitted-json-schemas.test.ts`, which now
 * asserts on the generated artifact.
 *
 * One `z.string().regex(...)` over an alternation of the registry codes and the
 * `CUSTOM:` namespace is a shape that parser CAN emit, so both contracts say the
 * same thing. The alternation is composed from `FindingCodeSchema.options`, so
 * a new finding code joins it with no human action — and a new refusal code
 * stays out of it with none either.
 *
 * The cost, stated plainly: `propertyNames` is now a `pattern` rather than an
 * `enum`, so an editor can flag a bad key but cannot complete a good one. That
 * is strictly better than today's nothing, and completion comes back the moment
 * the emitter learns union keys.
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
 * registry or behind `NonOverridableCode`. It exists only to tell refusals
 * apart in the MESSAGE; membership decisions still belong to `FindingCodeSchema`
 * and {@link CUSTOM_CHECK_CODE_PATTERN_SOURCE}.
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
 * `isCustomCheckCode` tests the prefix and nothing else, so
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
  if (RefusalCodeSchema.safeParse(code).success) {
    return `\`${code}\` is a refusal code: it reports that a run could not do its job — for`
      + ' `RESOURCE_CHECK_BROKEN`, that a declared check STOPPED RUNNING — and a refusal is'
      + ' unsilenceable by construction, so it is never a `validation.severity` or'
      + ' `validation.allow` key. You can downgrade or ignore a check with `CUSTOM:<its-name>`;'
      + ' you cannot downgrade the news that it stopped checking.';
  }
  if (REGISTRY_SHAPED_KEY.test(code)) {
    return `\`${code}\` is not a severity key this config accepts. Either it is a misspelled`
      + ' registry code, or it is one of the codes deliberately kept outside the override'
      + ' framework (docs/validation-codes.md, "Codes outside the overridable framework").'
      + ' You can downgrade or ignore a check with `CUSTOM:<its-name>`.';
  }
  return 'a custom severity key must be spelled `CUSTOM:<name>`, where `<name>` is a check\'s key'
    + ' under resources.checks';
}

/**
 * The accept set, as one pattern: every registry code, or a `CUSTOM:` name.
 *
 * Derived on both halves — the codes from the registry enum, the namespace from
 * its definition site — so neither half can fall behind what it describes.
 */
// eslint-disable-next-line security/detect-non-literal-regexp -- composed from the registry's own code names and a module constant; no input reaches it
const SEVERITY_KEY_PATTERN = new RegExp(
  `^(?:${[
    ...FindingCodeSchema.options.map((code) => escapeRegExpLiteral(code)),
    CUSTOM_CHECK_CODE_PATTERN_SOURCE,
  ].join('|')})$`,
);

/**
 * 🪤 The tailored refusal is carried by an `errorMap` rather than by the
 * `.regex()` check, and that placement is load-bearing. A message on the check
 * is one static string, so the two refusals {@link severityKeyRefusal} exists to
 * tell apart would collapse back into one — the thing that "sent half the
 * readers to the wrong place". The map sees `ctx.data`, so it can still read the
 * key and answer about THAT key. A non-string key cannot reach a record's key
 * schema, so the type-error fallback is defensive only.
 */
export const SeverityOverrideCodeSchema = z.string({
  errorMap: (_issue, ctx) => ({
    message: typeof ctx.data === 'string' ? severityKeyRefusal(ctx.data) : ctx.defaultError,
  }),
}).regex(SEVERITY_KEY_PATTERN);

// The `unknown` INPUT parameter is deliberate, not a leftover from satisfying the
// compiler. This schema's job is to validate a `validation:` block parsed out of a
// YAML file, which is `unknown` by construction — a caller that already had a
// typed value would have no reason to parse it. Typing the input narrower would
// only let a caller skip the check the schema exists to perform.
export const ValidationConfigSchema: z.ZodType<ValidationConfig, z.ZodTypeDef, unknown> = z.object({
  severity: z.record(SeverityOverrideCodeSchema, IssueSeveritySchema).optional(),
  // 🔑 `allow` stays keyed by the REGISTRY enum, and the asymmetry with
  // `severity` above is the decision, not an oversight. `severity` reaches a
  // check's findings for real: `resolveIssueSeverity` is code-agnostic and
  // `vat resources check` calls it. The allow filter is `IssueCode`-typed and
  // that command never runs it, so a `CUSTOM:` allow entry would parse, exempt
  // nothing, and report nothing — the adopter would believe a path was excused
  // while every finding under it still failed their build. A loud config error
  // is the honest answer until the check lane actually runs the allow filter.
  // Finding codes only, like `severity`: a refusal cannot be waived per path.
  allow: z.record(FindingCodeSchema, z.array(AllowEntrySchema)).optional(),
}).strict();
