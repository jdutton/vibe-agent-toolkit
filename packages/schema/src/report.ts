/**
 * The ONE envelope a VAT command publishes when it has looked at something and
 * has findings to report — or none.
 *
 * 🔑 **`examined` is REQUIRED, and that is the whole reason this envelope
 * exists.** Every one of the twelve command-level envelopes this replaced could
 * say "zero findings", and only some of them could say "of how many". A run over
 * an empty directory, a mistyped config key, a root one level too deep, a
 * population the ignore rules declined — each produced a document
 * byte-identical to a clean pass, and this repo has an incident log of exactly
 * that shape (`vat okf validate`'s `no-bundles`, `vat resources check`'s
 * `membersEnumerated`, `vat claude budget`'s `workingLocations` were each added
 * after such a green-without-running report shipped). A report that cannot be
 * built without a denominator cannot make that claim by omission.
 *
 * The status word is deliberately three-valued and LITERAL: `findings` means
 * the list is non-empty, `ok` means it is empty, `error` means the command
 * could not finish. It does not encode "is this actionable" — `summary` carries
 * the per-severity distribution and the exit code carries the gate verdict, so
 * a consumer reads the number it needs rather than decoding a word.
 *
 * `error` is a branch of the SAME envelope, not a second document: `examined`
 * is 0, `findings` is empty, `error` carries the reason and `data` is `null`
 * ({@link buildErrorReport}). The emitted `schemas/<command>.json` therefore
 * describes every run the command can end on — the five schemas used to
 * declare an `error` status that no producer wrote, while the real failure
 * document was a different shape an adopter's validator rejected.
 *
 * The finding element is {@link Finding}: `ValidationIssue`'s anchor contract
 * (`location` is the project-relative POSIX path of the file you would open,
 * `line` beside it, `field` for a pointer inside the document, `link` for an
 * href the finding is about) with `ignore` removed from the severity — an
 * ignored issue was suppressed by the adopter and is never published — and
 * `column` added, because the one lane that had it (`resources validate`)
 * carried it in a private shape.
 */

import { z } from 'zod';

import { SeveritySchema, type Severity } from './severity.js';
import { countBySeverity, ValidationIssueSchema, type SeverityCounts, type ValidationIssue } from './validation-issue.js';

export const REPORT_STATUSES = ['ok', 'findings', 'error'] as const;

export const ReportStatusSchema = z.enum(REPORT_STATUSES);

/** `ok`: examined, nothing found. `findings`: at least one. `error`: did not finish. */
export type ReportStatus = z.infer<typeof ReportStatusSchema>;

export const FindingSchema = ValidationIssueSchema
  .omit({ severity: true })
  .extend({
    severity: SeveritySchema,
    /** 1-based column within `line`, when the producer knows it. */
    column: z.number().int().positive().optional(),
  })
  .strict();

/**
 * One published finding. Structurally a {@link ValidationIssue} whose severity
 * is never `ignore`, plus an optional `column`.
 *
 * `code` is a plain string here, not the registry union: a report's findings
 * span every code space a lane draws on — the shipped registry, an adopter's
 * `CUSTOM:` checks, and a specification's own vocabulary (OKF names its codes
 * after its clauses). The registry union is the PRODUCER's type; the document
 * is what every producer's codes have in common.
 */
export interface Finding extends Omit<ValidationIssue, 'severity' | 'code'> {
  code: string;
  severity: Severity;
  /** 1-based column within {@link ValidationIssue.line}, when known. */
  column?: number;
}

export const SeverityCountsSchema = z.object({
  errors: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
  info: z.number().int().nonnegative(),
}).strict();

/**
 * The envelope, with `data` for what the command reports beyond its findings.
 *
 * `summary` is the existing {@link SeverityCounts} shape rather than a second
 * one keyed by severity name: `countBySeverity` is its single producer and 27
 * source files already read `.errors` / `.warnings` off it, so a second
 * spelling would have been the exact duplication this envelope exists to end.
 */
export interface Report<T> {
  status: ReportStatus;
  /** How many things were looked at. A report cannot say "0 findings" without saying "of N". */
  examined: number;
  findings: Finding[];
  /** The per-severity distribution of `findings`. */
  summary: SeverityCounts;
  /** Wall-clock milliseconds the run took, when the command measures it. */
  durationMs?: number;
  /** Why the run did not finish; present exactly when `status` is `error`. */
  error?: string;
  /** What the command reports beyond its findings. */
  data: T;
}

/**
 * The envelope a command publishes when it could not finish: {@link Report}
 * with nothing examined and `data: null`. A consumer of `schemas/<command>.json`
 * sees `data` as nullable for that reason; a producer's own `Report<T>` never
 * is, because a completed run always has its data.
 */
export interface ErrorReport extends Report<null> {
  status: 'error';
  examined: 0;
  error: string;
  data: null;
}

/**
 * The Zod schema of a {@link Report} whose `data` is `dataSchema`.
 *
 * Strict at every level it owns: an envelope key nobody declared is a typo in
 * a producer or a consumer, and the emitted `schemas/<command>.json` is what
 * an adopter validates their `jq` recipe against.
 *
 * @param dataSchema - The schema of the command's own `data`
 * @returns The strict envelope schema
 */
export function reportSchema<T extends z.ZodTypeAny>(dataSchema: T): ReportZodSchema<T> {
  return z.object({
    status: ReportStatusSchema,
    examined: z.number().int().nonnegative(),
    findings: z.array(FindingSchema),
    summary: SeverityCountsSchema,
    durationMs: z.number().nonnegative().optional(),
    error: z.string().optional(),
    data: dataSchema.nullable(),
  }).strict();
}

/** The strict object schema {@link reportSchema} returns, spelled out so the shape is nameable. */
export type ReportZodSchema<T extends z.ZodTypeAny> = z.ZodObject<
  {
    status: typeof ReportStatusSchema;
    examined: z.ZodNumber;
    findings: z.ZodArray<typeof FindingSchema>;
    summary: typeof SeverityCountsSchema;
    durationMs: z.ZodOptional<z.ZodNumber>;
    error: z.ZodOptional<z.ZodString>;
    data: z.ZodNullable<T>;
  },
  'strict'
>;

/**
 * The keys every {@link Report} carries, for a test that asks "is this schema
 * an envelope?" without parsing a document through it.
 */
export const REPORT_ENVELOPE_KEYS = ['status', 'examined', 'findings', 'summary', 'data'] as const;

/**
 * The published findings among a validator's issues: everything the adopter
 * did not suppress.
 *
 * `ignore` is dropped, not re-labelled. It is the adopter's own
 * `validation.allow` decision, and a report that listed a silenced finding
 * under any other name would resurrect it.
 *
 * @param issues - A validator's issues, severities already resolved
 * @returns The same issues minus the ignored ones, typed as findings
 */
export function toFindings(issues: readonly ValidationIssue[]): Finding[] {
  const findings: Finding[] = [];
  for (const issue of issues) {
    if (issue.severity !== 'ignore') findings.push(issue as Finding);
  }
  return findings;
}

/** What {@link buildReport} needs: the denominator, the findings, and the command's own data. */
export interface ReportInput<T> {
  examined: number;
  findings: readonly Finding[];
  data: T;
  durationMs?: number | undefined;
}

/**
 * Assemble a completed run's report. Status and summary are DERIVED from the
 * findings here, in the one place, so no command can publish a status its own
 * list contradicts.
 *
 * @param input - The denominator, the findings, and the command's data
 * @returns The report, status `ok` or `findings`
 */
export function buildReport<T>(input: ReportInput<T>): Report<T> {
  const findings = [...input.findings];
  return {
    status: findings.length === 0 ? 'ok' : 'findings',
    examined: input.examined,
    findings,
    summary: countBySeverity(findings),
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    data: input.data,
  };
}

/**
 * The envelope for a run that did not finish. Same keys as a completed
 * report, so one schema — and one `jq` recipe — reads both.
 *
 * @param error - Why the run did not finish, for a human
 * @param durationMs - Wall-clock milliseconds until it stopped
 * @returns The `status: 'error'` envelope, nothing examined, `data: null`
 */
export function buildErrorReport(error: string, durationMs: number): ErrorReport {
  return {
    status: 'error',
    examined: 0,
    findings: [],
    summary: { errors: 0, warnings: 0, info: 0 },
    durationMs,
    error,
    data: null,
  };
}
