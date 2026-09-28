/**
 * The ONE envelope a VAT command publishes when it has looked at something and
 * has findings to report — or none — or could not finish.
 *
 * 🔑 **`examined` is REQUIRED, and that is the whole reason this envelope
 * exists.** Every one of the per-command envelopes this replaced could say
 * "zero findings", and only some of them could say "of how many". A run over
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
 * 🔑 **The schema is a per-status discriminated union, not only the TS type.**
 * `ok` carries no findings and its `data`; `findings` carries at least one and
 * its `data`; `error` carries `error: { code, message }` — `code` a registered
 * REFUSAL (`RefusalCode`), never a finding code — and `data` that is the
 * command's own type or `null`. A single object with a nullable `data` and an
 * optional `error` let an `ok` report with `data: null` validate, and let an
 * `error` report carry no reason; the union makes both unrepresentable in the
 * emitted `schemas/<command>.json` an adopter validates against.
 *
 * `error` means "did not finish", NOT "did nothing": the branch keeps a real
 * `examined`, the `findings` (and derived `summary`) of whatever finished, and
 * partial `data` where the verb produced any ({@link buildErrorReport}).
 * "Nothing finished" is spelled out by the caller — `examined: 0, findings: [],
 * data: null` — never a default that silently drops finished work.
 *
 * 🔑 **The gate is in the document.** `gate: { strict }` is required on every
 * branch: whether warnings fail this run is a fact about the run, so the exit
 * code (`exitCodeForReport`) reads it from the published document rather than
 * from a call-site option a reader of the document cannot see.
 *
 * The finding element is {@link Finding}: `ValidationIssue`'s anchor contract
 * (`location` is the project-relative POSIX path of the file you would open,
 * `line` beside it, `field` for a pointer inside the document, `link` for an
 * href the finding is about) with `ignore` removed from the severity — an
 * ignored issue was suppressed by the adopter and is never published — and
 * `column` added, because the one lane that had it (`resources validate`)
 * carried it in a private shape. {@link reportSchema} takes the finding schema
 * as a REQUIRED parameter so a verb whose findings carry more (a subject, a
 * harness) passes a narrowed one rather than widening this one.
 */

import { z } from 'zod';

import { SeveritySchema, type Severity } from './severity.js';
import { RefusalCodeSchema, type RefusalCode } from './validation-codes.js';
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

/** The gate the run was judged by. `strict`: warnings fail it, as errors always do. */
export const GateSchema = z.object({ strict: z.boolean() }).strict();

/** The gate the run was judged by — recorded in the document so its exit code derives from it. */
export interface Gate {
  strict: boolean;
}

/** Why a run did not finish: a registered refusal code and the words for a human. */
const ReportErrorSchema = z.object({
  code: RefusalCodeSchema,
  message: z.string().min(1),
}).strict();

/** Why a run did not finish. `code` is a refusal — a finding code is never an `error.code`. */
export interface ReportError {
  code: RefusalCode;
  message: string;
}

/**
 * What every branch carries.
 *
 * `summary` is the existing {@link SeverityCounts} shape rather than a second
 * one keyed by severity name: `countBySeverity` is its single producer and
 * many source files already read `.errors` / `.warnings` off it, so a second
 * spelling would have been the exact duplication this envelope exists to end.
 */
interface ReportBase {
  /** How many things were looked at. A report cannot say "0 findings" without saying "of N". */
  examined: number;
  findings: Finding[];
  /** The per-severity distribution of `findings`. */
  summary: SeverityCounts;
  /** The gate the exit code is derived from. */
  gate: Gate;
  /** Wall-clock milliseconds the run took, when the command measures it. */
  durationMs?: number;
}

/** A completed run that found nothing. */
export interface OkReport<T> extends ReportBase {
  status: 'ok';
  data: T;
}

/** A completed run that found at least one thing. */
export interface FindingsReport<T> extends ReportBase {
  status: 'findings';
  data: T;
}

/** A run that did not finish, with whatever did: `data` is the command's own type, or `null` when nothing was produced. */
export interface ErrorReport<T> extends ReportBase {
  status: 'error';
  error: ReportError;
  data: T | null;
}

/** The envelope, discriminated on `status`. */
export type Report<T> = OkReport<T> | FindingsReport<T> | ErrorReport<T>;

/** The one shape a finding schema must produce: a severity the summary can count. */
type FindingZodSchema = z.ZodType<Pick<Finding, 'severity'>>;

/**
 * Every published finding's severity, counted, must equal `summary`.
 *
 * On the WHOLE union rather than per branch: a `ZodEffects` cannot be a
 * `discriminatedUnion` option, and zod throws at construction if it is.
 */
function summaryMatchesFindings(
  report: { findings: readonly Pick<Finding, 'severity'>[]; summary: SeverityCounts },
  ctx: z.RefinementCtx,
): void {
  const counted = countBySeverity(report.findings);
  const { summary } = report;
  if (counted.errors !== summary.errors || counted.warnings !== summary.warnings || counted.info !== summary.info) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['summary'],
      message: `summary ${JSON.stringify(summary)} disagrees with the findings, which count ${JSON.stringify(counted)}`,
    });
  }
}

/**
 * The Zod schema of a {@link Report} whose `data` is `dataSchema` and whose
 * findings are `findingSchema`.
 *
 * Strict at every level it owns: an envelope key nobody declared is a typo in
 * a producer or a consumer, and the emitted `schemas/<command>.json` is what
 * an adopter validates their `jq` recipe against.
 *
 * @param dataSchema - The schema of the command's own `data`
 * @param findingSchema - The schema of one finding — REQUIRED, so a verb with a
 *   narrower finding passes it rather than widening {@link FindingSchema}
 * @returns The per-status union, refined so `summary` agrees with `findings`
 */
export function reportSchema<T extends z.ZodTypeAny, F extends FindingZodSchema>(
  dataSchema: T,
  findingSchema: F,
): ReportZodSchema<T, F> {
  // Tests and JavaScript callers are not typechecked: a one-argument call would
  // otherwise build an array of `undefined` and fail on the first finding.
  if ((findingSchema as F | undefined) === undefined) {
    throw new TypeError('reportSchema: a finding schema is required');
  }
  const base = {
    examined: z.number().int().nonnegative(),
    summary: SeverityCountsSchema,
    gate: GateSchema,
    durationMs: z.number().nonnegative().optional(),
  };
  return z.discriminatedUnion('status', [
    z.object({ status: z.literal('ok'), ...base, findings: z.array(findingSchema).max(0), data: dataSchema }).strict(),
    z.object({ status: z.literal('findings'), ...base, findings: z.array(findingSchema).min(1), data: dataSchema }).strict(),
    z.object({
      status: z.literal('error'),
      ...base,
      findings: z.array(findingSchema),
      error: ReportErrorSchema,
      data: dataSchema.nullable(),
    }).strict(),
  ]).superRefine(summaryMatchesFindings);
}

/**
 * The fields every branch of {@link reportSchema} shares. A type alias, not an
 * interface: a zod shape must satisfy `ZodRawShape`'s string index signature,
 * which an alias gets implicitly and an interface does not.
 */
type ReportZodBase<F extends FindingZodSchema> = {
  examined: z.ZodNumber;
  summary: typeof SeverityCountsSchema;
  gate: typeof GateSchema;
  durationMs: z.ZodOptional<z.ZodNumber>;
  findings: z.ZodArray<F>;
};

/** The union {@link reportSchema} returns, spelled out so the shape is nameable. */
export type ReportZodSchema<T extends z.ZodTypeAny, F extends FindingZodSchema> = z.ZodEffects<
  z.ZodDiscriminatedUnion<
    'status',
    [
      z.ZodObject<ReportZodBase<F> & { status: z.ZodLiteral<'ok'>; data: T }, 'strict'>,
      z.ZodObject<ReportZodBase<F> & { status: z.ZodLiteral<'findings'>; data: T }, 'strict'>,
      z.ZodObject<
        ReportZodBase<F> & { status: z.ZodLiteral<'error'>; error: typeof ReportErrorSchema; data: z.ZodNullable<T> },
        'strict'
      >,
    ]
  >
>;

/**
 * The keys every {@link Report} branch carries, for a test that asks "is this
 * schema an envelope?" without parsing a document through it.
 */
export const REPORT_ENVELOPE_KEYS = ['status', 'examined', 'findings', 'summary', 'gate', 'data'] as const;

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

/** What {@link buildReport} needs: the denominator, the findings, the gate, and the command's own data. */
export interface ReportInput<T> {
  examined: number;
  findings: readonly Finding[];
  data: T;
  gate: Gate;
  durationMs?: number | undefined;
}

/**
 * What {@link buildErrorReport} needs. Every field REQUIRED: an error report
 * must say what finished. "Nothing finished" is spelled out at the call site
 * (`examined: 0, findings: [], data: null`) — never a default that silently
 * drops finished work.
 */
export interface ErrorReportInput<T> {
  error: ReportError;
  gate: Gate;
  examined: number;
  findings: readonly Finding[];
  data: T | null;
  durationMs: number | undefined;
}

/**
 * The fields every branch shares, with `summary` DERIVED from the findings —
 * the one place it is computed, for completed and unfinished runs alike.
 *
 * @param input - The denominator, the findings, the gate and the duration
 * @returns The shared fields, in published key order
 */
function reportBase(input: Pick<ReportInput<unknown>, 'examined' | 'findings' | 'gate' | 'durationMs'>): ReportBase {
  const findings = [...input.findings];
  return {
    examined: input.examined,
    findings,
    summary: countBySeverity(findings),
    gate: input.gate,
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
  };
}

/**
 * Assemble a completed run's report. Status and summary are DERIVED from the
 * findings here, in the one place, so no command can publish a status its own
 * list contradicts.
 *
 * @param input - The denominator, the findings, the gate, and the command's data
 * @returns The report, status `ok` or `findings`
 */
export function buildReport<T>(input: ReportInput<T>): OkReport<T> | FindingsReport<T> {
  const base = reportBase(input);
  return { status: base.findings.length === 0 ? 'ok' : 'findings', ...base, data: input.data };
}

/**
 * The envelope for a run that did not finish. Same keys as a completed report
 * plus `error`, so one schema — and one `jq` recipe — reads both. The summary is
 * derived from the findings that finished, exactly as {@link buildReport} does.
 *
 * @param input - Why it stopped, the gate, and everything that did finish
 * @returns The `status: 'error'` envelope
 */
export function buildErrorReport<T>(input: ErrorReportInput<T>): ErrorReport<T> {
  return { status: 'error', ...reportBase(input), error: input.error, data: input.data };
}
