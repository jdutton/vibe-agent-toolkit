/**
 * Unified validation issue type.
 *
 * `ValidationIssue` is the single shape every VAT validator emits. Its `code`
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
 * | `field`    | Dotted pointer INSIDE that document                          | `frontmatter.description` |
 * | `link`     | A link href / target the issue is about (never the file to open) | `./refs/missing.md` |
 *
 * `location` is **always relative** — enforced by the schema refinement below.
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

import {
  CODE_REGISTRY,
  type InfoCode,
  type IssueCode,
  type IssueSeverity,
  type NonOverridableCode,
} from './validation-codes.js';

/** Full code space: registry codes (overridable) + info codes + structural/non-overridable codes. */
export type ValidationIssueCode = IssueCode | InfoCode | NonOverridableCode;

/**
 * Host-independent absolute-path test, mirroring `isAbsoluteAnyPlatform` in
 * `@vibe-agent-toolkit/utils`. Inlined because `schema` is the bottom of
 * the dependency graph and carries no workspace runtime dependencies; a
 * Windows-absolute `location` must be rejected even when validating on POSIX CI.
 */
function isAbsoluteAnyPlatform(p: string): boolean {
  return path.posix.isAbsolute(p) || path.win32.isAbsolute(p);
}

export const ValidationIssueSchema = z.object({
  code: z.string(),                                  // full code space; narrowed in the TS type below
  severity: z.enum(['error', 'warning', 'info', 'ignore']),
  message: z.string(),
  location: z.string()
    .refine((v) => !isAbsoluteAnyPlatform(v), {
      message: 'location must be a project-relative POSIX path, not an absolute path',
    })
    .refine((v) => !v.includes('\\'), {
      message: 'location must use forward slashes, not backslashes',
    })
    .optional(),
  line: z.number().int().positive().optional(),
  field: z.string().optional(),
  link: z.string().optional(),
  fix: z.string().optional(),
  reference: z.string().optional(),
  suggestion: z.string().optional(),
}).strict();

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
  /** Dotted pointer inside the document at {@link ValidationIssue.location}, e.g. `frontmatter.description`. */
  field?: string;
  /** A link href or target the issue concerns — not the file to open. */
  link?: string;
  fix?: string;
  reference?: string;
  suggestion?: string;
}

/** Build an issue from the registry, filling severity/fix/reference from the code entry. */
export function createRegistryIssue(
  code: IssueCode,
  message: string,
  extras: Partial<Pick<ValidationIssue, 'location' | 'line' | 'field' | 'link' | 'suggestion'>> = {},
): ValidationIssue {
  const e = CODE_REGISTRY[code];
  return { code, severity: e.defaultSeverity, message, fix: e.fix, reference: e.reference, ...extras };
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
export function countBySeverity(issues: readonly ValidationIssue[]): SeverityCounts {
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
 * The single answer to "issues → status": the worst ACTIONABLE severity.
 *
 * There were five implementations of this and three different answers for an
 * info-only set — `warning` here, `success` in `vat audit`, and in
 * `corpus/runner` a `statusFromCounts(errors, warnings)` whose signature could
 * not see info at all. Two lanes could therefore report different statuses for
 * the same artifact.
 *
 * Info-only resolves to `success` because an informational observation is not
 * something the consumer must act on. That is only defensible when the counts
 * ride alongside — pair every use of this with {@link countBySeverity}, or the
 * status becomes the silence it used to be.
 */
export function calculateValidationStatus(
  issues: readonly ValidationIssue[],
): 'success' | 'warning' | 'error' {
  const { errors, warnings } = countBySeverity(issues);
  if (errors > 0) {
    return 'error';
  }
  return warnings > 0 ? 'warning' : 'success';
}
