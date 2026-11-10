/**
 * Unified validation issue type.
 *
 * `ValidationIssue` is the shape the shared validators (skills, resources,
 * plugins, marketplaces) emit, and the element `report.ts`'s published
 * `Finding` is built from; lanes with a private finding shape are the ones
 * still being folded onto it. Its `code`
 * spans the FULL code space: registry codes (overridable via config), plus
 * `InfoCode` and `NonOverridableCode` (structural reports / prerequisites that
 * bypass the severity-override framework).
 *
 * ## The anchor contract — one meaning per field
 *
 * An issue points at up to four independent things, and each has its OWN field.
 * None of them is ever packed into another with a separator:
 *
 * | field      | means                                                        | example |
 * |------------|--------------------------------------------------------------|---------|
 * | `location` | **The file you would open to fix this**, as a project-relative POSIX path | `packages/cli/SKILL.md` |
 * | `line`     | 1-based line within `location`                               | `24` |
 * | `column`   | 1-based column within `line`                                 | `7` |
 * | `field`    | Dotted pointer INSIDE that document                          | `frontmatter.description` |
 * | `link`     | A link href / target the issue is about (never the file to open) | `./refs/missing.md` |
 *
 * `location` must be **relative**. The schema refinement below refuses an
 * absolute one — but only where an issue is PARSED, and producers build issues
 * as plain objects, so the refinement binds a consumer's `safeParse`, not a
 * producer's constructor. The producer-side guard is `issueLocation`; a
 * producer that joins an absolute root itself is not caught by anything here.
 * Absolute paths leak the developer's home directory into CI logs and make the
 * `validation.allow` globs (which match against `location`) unwritable. A
 * consumer can therefore resolve every `location` against one known root and
 * `grep`/glob them uniformly.
 *
 * Producers: use `issueLocation(absPath, projectRoot)` from
 * `@vibe-agent-toolkit/utils` rather than hand-rolling the relativization.
 */

import path from 'node:path';

import { z } from 'zod';

import { escapeRegExpLiteral } from './regexp-escape.js';
import { presenceImplies } from './schema-utils.js';
import {
  CODE_REGISTRY,
  IssueSeveritySchema,
  type InfoCode,
  type IssueCode,
  type IssueSeverity,
  type NonOverridableCode,
} from './validation-codes.js';

/**
 * What a user-authored check's validation code is prefixed with.
 *
 * 🔑 **THE definition site for the `CUSTOM:` code space** — the minter
 * ({@link customCheckCode}), the acceptor ({@link isCustomCheckCode}) and the
 * type ({@link CustomCheckCode}) are all below it, and `validation-config.ts`
 * refines the `validation.severity` key schema with the acceptor.
 *
 * That co-location is the whole point, and it was not academic: the minter lived
 * in `resources` while the config's key schema was the closed registry enum, so
 * the two spaces disagreed about whether `CUSTOM:my-check` was a code an adopter
 * could name. It was mintable and unconfigurable, and a config containing what
 * three separate docs prescribed failed `ProjectConfigSchema` outright — which
 * is not a `vat resources check` failure but a `loadConfig` failure, so it broke
 * every command. One definition, in the package at the bottom of the dependency
 * graph, is what makes that disagreement unrepresentable.
 */
export const CUSTOM_CHECK_CODE_PREFIX = 'CUSTOM:';

/**
 * A finding from a project's own `resources.checks` SQL assertion.
 *
 * Namespaced so the user's code space and the shipped registry's stay disjoint
 * **by construction**. The registry is closed and every entry carries a default
 * severity, so an un-namespaced user code would either shadow a shipped one or
 * reach `CODE_REGISTRY[code].defaultSeverity` with no entry to read. A
 * `CUSTOM:` code never does: it carries the severity its check declared.
 */
export type CustomCheckCode = `${typeof CUSTOM_CHECK_CODE_PREFIX}${string}`;

/**
 * The validation code one named check's findings carry.
 *
 * @param name - The check's key in `resources.checks`
 * @returns The namespaced code
 */
export function customCheckCode(name: string): CustomCheckCode {
  return `${CUSTOM_CHECK_CODE_PREFIX}${name}`;
}

/**
 * The rule "`CUSTOM:` then a name", as a regex fragment.
 *
 * 🔑 **A regex because the rule has TWO consumers, and one of them cannot call
 * a function.** {@link isCustomCheckCode} below is the run-time acceptor;
 * `schemas/validation-config.json` — which an adopter's editor and CI validate
 * `vibe-agent-toolkit.config.yaml` against — is the second, and a JSON Schema
 * can only carry a `pattern`. When the rule lived only in the predicate, the
 * generated artifact carried NO key constraint at all and accepted
 * `LNIK_OUTSIDE_PROJECT` that `loadConfig` then refused. Deriving both from this
 * one source is what makes those two contracts unable to disagree.
 *
 * It is exactly as WIDE as the prefix test it replaces, which is the property
 * that matters: `[\s\S]+` is any character including a newline, so a check named
 * with dots, spaces or anything else `resources.checks` (`z.record(z.string())`)
 * admits stays overridable. Narrowing this would make a legitimately-named check
 * un-silenceable — an adopter told they could silence an inherited check,
 * writing the only key that could, and having their whole config refused.
 *
 * Unanchored on purpose: `validation-config.ts` splices it into an alternation
 * beside the registry codes, and anchors the whole thing.
 */
export const CUSTOM_CHECK_CODE_PATTERN_SOURCE
  = escapeRegExpLiteral(CUSTOM_CHECK_CODE_PREFIX) + String.raw`[\s\S]+`;

// eslint-disable-next-line security/detect-non-literal-regexp -- composed from CUSTOM_CHECK_CODE_PREFIX, a module constant; no input reaches it
const CUSTOM_CHECK_CODE_PATTERN = new RegExp(`^${CUSTOM_CHECK_CODE_PATTERN_SOURCE}$`);

/**
 * Whether a code names a user-authored check rather than a shipped one.
 *
 * The rule is exactly the minter's shape read backwards — the prefix, then a
 * name — and it is read from {@link CUSTOM_CHECK_CODE_PATTERN_SOURCE} so that
 * this predicate and the emitted JSON Schema's `pattern` cannot drift apart.
 *
 * The one thing it must refuse is the bare prefix. `CUSTOM:` names no check, and
 * accepting it would let a typo sit in a config silently overriding nothing.
 *
 * @param code - Any validation code
 * @returns True iff `code` is `CUSTOM:` followed by a non-empty name
 */
export function isCustomCheckCode(code: string): code is CustomCheckCode {
  return CUSTOM_CHECK_CODE_PATTERN.test(code);
}

/** Full code space: registry codes (overridable) + info codes + structural/non-overridable codes + user checks. */
export type ValidationIssueCode = IssueCode | InfoCode | NonOverridableCode | CustomCheckCode;

/** A drive prefix (`C:` or `C:foo`), which is never project-relative however POSIX it looks. */
const DRIVE_PREFIX = /^[A-Za-z]:/;

/** What a `location` may be — the one spelling every refusal of one states. */
export const PROJECT_LOCATION_RULE
  = String.raw`a non-empty relative path with / separators inside the root (not the root itself; no leading / or \, no drive, no UNC path, no climbing .., and no \ where \ is the platform separator)`;

/**
 * 🔑 THE one definition of "absolute" for a path a report states relative to its root, the same on
 * every host: POSIX-rooted, Windows-rooted (leading `\`, UNC, `C:\x`), or drive-prefixed (`C:x`).
 */
export function isAbsoluteOnAnyHost(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || DRIVE_PREFIX.test(value);
}

/**
 * 🔑 **THE location predicate** — the one answer to "may this string be an
 * issue's `location`?". {@link ValidationIssueSchema} refines with it and the
 * resources projection's `findingLocation` (a row value → a finding's location)
 * calls it, so a value one lane emits is a value the other parses. Inlined here,
 * not in `utils`, because `schema` is the bottom of the dependency graph.
 *
 * A location is non-empty, not absolute ({@link isAbsoluteOnAnyHost}: no
 * leading `/` or `\`, no UNC path, no drive — checked on every host, so a
 * Windows-absolute value is refused on POSIX CI too), not the root itself (a
 * value that normalises to `.`), and does not climb out of the root. A
 * backslash anywhere else is refused only where it IS the platform separator
 * (win32): there it is a separator a producer forgot to convert, while on
 * POSIX it is a legal filename character and the projection holds real files
 * named with one (`docs/x\y.md` is one file).
 *
 * @param value - A candidate location
 * @returns Whether it may be a `location`
 */
export function isProjectLocation(value: string): boolean {
  if (value.length === 0 || isAbsoluteOnAnyHost(value)) return false;
  if (path.sep === '\\' && value.includes('\\')) return false;
  const normalized = path.posix.normalize(value);
  // `posix.normalize` keeps a trailing slash: `./` and `docs/../` normalise to `./`, still the root.
  return normalized !== '.' && normalized !== './' && normalized !== '..' && !normalized.startsWith('../');
}

/**
 * A value as an issue's `location`, when it can be one — the one way a producer turns a computed
 * path into a location. It must pass {@link isProjectLocation}, and is emitted in its normalised
 * POSIX form: `./docs/a.md` as `docs/a.md`, `docs/../README.md` as `README.md`.
 *
 * @param value - A candidate location, e.g. what `issueLocation` returned
 * @returns The location, or undefined when the value is no location (empty, absolute, on a drive,
 *   the root itself, climbing out of the root): the caller then omits `location` and names the
 *   path in its message
 */
export function projectLocationOf(value: string): string | undefined {
  return isProjectLocation(value) ? path.posix.normalize(value) : undefined;
}

/**
 * An issue's `message` and `location` for a computed path: the location when the path can be one
 * ({@link projectLocationOf}), else no location and the path named in the message — so a producer
 * whose subject lies outside its root (another drive, `../shared-docs`, the root itself) degrades
 * instead of emitting a finding the published schema refuses.
 *
 * @param message - The issue's message
 * @param relative - The subject's path relative to the location root (`issueLocation`'s answer)
 * @returns The fields to spread into the issue
 */
export function anchoredAt(message: string, relative: string): { message: string; location?: string } {
  const location = projectLocationOf(relative);
  return location === undefined ? { message: `${message} (${relative})` } : { message, location };
}

/** A `column` is within a `line`: an issue carrying one carries the other. `at` is the issue's path in the parsed value. */
export function columnRequiresLine(
  issue: { line?: number | undefined; column?: number | undefined },
  context: z.RefinementCtx,
  at: readonly (string | number)[],
): void {
  if (issue.column !== undefined && issue.line === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'column is within a line, so an issue carrying it must carry line', path: [...at, 'column'] });
  }
}

/** {@link columnRequiresLine} as JSON Schema, which `zod-to-json-schema` would drop. */
export const COLUMN_REQUIRES_LINE_JSON_RULE: Readonly<Record<string, unknown>> = presenceImplies('column', { required: ['line'] });

/** {@link ValidationIssueSchema} without its refinement, to derive finding schemas from; never validate with it. */
export const ValidationIssueObjectSchema = z.object({
  code: z.string(),                                  // full code space; narrowed in the TS type below
  severity: IssueSeveritySchema,
  message: z.string(),
  location: z.string()
    .refine(isProjectLocation, { message: `location must be ${PROJECT_LOCATION_RULE}` })
    .describe(`The file to open to fix this: ${PROJECT_LOCATION_RULE}`)
    .optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  field: z.string().optional(),
  link: z.string().optional(),
  fix: z.string().optional(),
  reference: z.string().optional(),
  suggestion: z.string().optional(),
}).strict();

/** One validation issue: {@link ValidationIssueObjectSchema}, refined so a `column` carries its `line`. */
export const ValidationIssueSchema = ValidationIssueObjectSchema.superRefine((issue, context) => columnRequiresLine(issue, context, []));

// Schema validates structure; the TS type narrows code+severity and uses exact
// optional properties (no `| undefined`) to match how validators construct issues
// under `exactOptionalPropertyTypes`.
export interface ValidationIssue {
  code: ValidationIssueCode;
  severity: IssueSeverity;
  message: string;
  /** Project-relative POSIX path of the file to open. Never absolute. */
  location?: string;
  /** 1-based line within {@link ValidationIssue.location}. */
  line?: number;
  /** 1-based column within {@link ValidationIssue.line}. */
  column?: number;
  /** Dotted pointer inside the document at {@link ValidationIssue.location}, e.g. `frontmatter.description`. */
  field?: string;
  /** A link href or target the issue concerns — not the file to open. */
  link?: string;
  fix?: string;
  reference?: string;
  suggestion?: string;
}

/**
 * Build an issue from the registry, filling severity/fix/reference from the code entry. A
 * `location` that cannot be one is routed through {@link anchoredAt}: omitted, its path named in
 * the message.
 */
export function createRegistryIssue(
  code: IssueCode,
  message: string,
  extras: Partial<Pick<ValidationIssue, 'location' | 'line' | 'column' | 'field' | 'link' | 'suggestion'>> = {},
): ValidationIssue {
  const e = CODE_REGISTRY[code];
  const { location, ...rest } = extras;
  const anchored = location === undefined ? { message } : anchoredAt(message, location);
  return { code, severity: e.defaultSeverity, fix: e.fix, reference: e.reference, ...rest, ...anchored };
}

/**
 * Per-severity issue counts, published beside a status rather than folded into it.
 *
 * A status names the worst ACTIONABLE severity, which is a three-value answer to
 * a four-value question — the distribution is not recoverable from it. Publishing
 * the counts is what makes a two- or three-valued status honest: `success` then
 * means "nothing you must act on", not "there was nothing to see".
 */
export interface SeverityCounts {
  errors: number;
  warnings: number;
  info: number;
}

/**
 * Count issues by resolved severity.
 *
 * `ignore` is excluded from every bucket: those findings were suppressed by the
 * adopter's own `validation.allow` config, and counting them would resurrect
 * something they deliberately silenced.
 */
export function countBySeverity(issues: readonly Pick<ValidationIssue, 'severity'>[]): SeverityCounts {
  let errors = 0;
  let warnings = 0;
  let info = 0;
  for (const issue of issues) {
    if (issue.severity === 'error') {
      errors += 1;
    } else if (issue.severity === 'warning') {
      warnings += 1;
    } else if (issue.severity === 'info') {
      info += 1;
    }
  }
  return { errors, warnings, info };
}

/**
 * The ONE issues → status derivation, shared by every library result and
 * `buildReport`. LITERAL: an info-only set is `findings`; how much is
 * actionable is {@link countBySeverity}'s `summary`. `ignore` is never
 * published, so a suppressed-only set is `ok`, agreeing with its zero summary.
 */
export function resultStatus(issues: readonly Pick<ValidationIssue, 'severity'>[]): 'ok' | 'findings' {
  return issues.some(issue => issue.severity !== 'ignore') ? 'findings' : 'ok';
}

/**
 * The `status` and `summary` a result publishes, derived TOGETHER from one
 * issue list — the one helper every producer spreads, so no result can carry a
 * status or a count that disagrees with the issues beside it (a producer that
 * appended findings after publishing its counts did exactly that).
 */
export function summarizeIssues(
  issues: readonly Pick<ValidationIssue, 'severity'>[],
): { status: 'ok' | 'findings'; summary: SeverityCounts } {
  return { status: resultStatus(issues), summary: countBySeverity(issues) };
}
