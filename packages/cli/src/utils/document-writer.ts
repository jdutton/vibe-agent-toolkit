/**
 * The ONE writer of a `vat` command's stdout document.
 *
 * Every shape a command publishes is registered in `report-schemas.ts`, and
 * this module is how it leaves: the document is looked up by verb, passed
 * through the run-integrity refusal the registry's denominator declares,
 * validated against its own published schema, rendered as yaml, json or text,
 * and — for the `end…` functions — the process ends on the code the WRITTEN
 * document derives. `local/no-stdout-outside-writer` keeps every other route
 * to stdout out of `commands/`.
 *
 * 🔑 **Validated before a byte leaves.** A document the published schema
 * rejects is a defect in VAT, and it throws here — the last resort ends it on
 * `ERROR` — rather than shipping a shape an adopter's parser was promised
 * would never appear.
 */

import { writeFileSync } from 'node:fs';

import {
  buildErrorReport,
  CODE_REGISTRY,
  errorDiagnostics,
  exitCodeForReport,
  type Finding,
  type Gate,
  type RefusalCode,
  type Report,
  type ValidationIssue,
} from '@vibe-agent-toolkit/schema';
import { isFsFaultError, suppressedFaultsOf, TREE_CLEANUP_INCOMPLETE_CODE } from '@vibe-agent-toolkit/utils';
import { parse as parseYaml } from 'yaml';

import {
  artifactShapeFor,
  exitCodeForExternal,
  reportShapeFor,
  type DocumentFormat,
  type ExternalOutcome,
  type ExternalVerb,
  type LegacyVerb,
  type ReportVerb,
} from '../report-schemas.js';

import { errorMessageOf, refusalCodeOf, withFsFaultRemedy } from './command-refusal.js';
import { debugDiagnosticsEnabled } from './debug-diagnostics.js';
import { renderYamlDocument, writeStdoutSync } from './output.js';
import { withRunIntegrity } from './run-integrity.js';

/** One finding as a compiler-style line: `location:line:column: severity: message [code]`. */
function findingLine(finding: Finding): string {
  const anchor = [finding.location, finding.line, finding.column].filter((part) => part !== undefined).join(':');
  const line = `${finding.severity}: ${finding.message} [${finding.code}]`;
  return anchor === '' ? line : `${anchor}: ${line}`;
}

/**
 * The generic `--format text` rendering: one line per finding, then the status
 * line with the counts and the denominator.
 */
function renderReportText(report: Report<unknown>, unit: string): string {
  const { errors, warnings, info } = report.summary;
  const lines = report.findings.map(findingLine);
  if (report.status === 'error') lines.push(`error: ${report.error.message} [${report.error.code}]`);
  lines.push(`status: ${report.status} — ${errors} errors, ${warnings} warnings, ${info} info (examined ${report.examined} ${unit})`);
  return `${lines.join('\n')}\n`;
}

/**
 * Write `document` in a structured format — `text` has no structure, so it is YAML.
 *
 * YAML opens with `---` and has NO trailing marker: `---` opens a document, so a
 * trailer made every stdout a two-document stream a plain `YAML.parse()` refused.
 *
 * The ordinary stream write, not {@link writeStdoutSync}: a document follows
 * progress written through `console.log`, and a synchronous fd-1 write would
 * jump ahead of anything still buffered there. `makeStdioBlocking()` at startup
 * makes both channels synchronous, so nothing is lost at `process.exit`.
 */
function writeStructured(document: unknown, format: DocumentFormat): void {
  process.stdout.write(format === 'json' ? `${JSON.stringify(document, null, 2)}\n` : `---\n${renderYamlDocument(document)}`);
}

/**
 * The document a report verb publishes, without writing it: the run-integrity
 * refusal its registered denominator declares, then its published schema.
 *
 * For a lane that needs the published document before writing it — a command
 * that warns on stderr with the refusal the writer adds. {@link writeDocument}
 * goes through it too. (A phase of `vat build` / `validate` / `verify` hands
 * back its report BEFORE this pass: the orchestrator judges zero examined on
 * the whole run.)
 *
 * @param verb - The registered verb
 * @param report - The document as the verb built it
 * @returns The document as published
 * @throws When the verb is unregistered or its schema rejects the document (a defect)
 */
export function publishedReport<T>(verb: ReportVerb, report: Report<T>): Report<T> {
  const entry = reportShapeFor(verb);
  const published = withRunIntegrity(report, entry.examined);
  entry.schema.parse(published);
  return published;
}

/**
 * Publish a report verb's document.
 *
 * @param verb - The registered verb, as typed after `vat`
 * @param report - The document as the verb built it
 * @param format - How to render it
 * @returns The document actually written — after the run-integrity refusal
 * @throws When the verb is unregistered or its schema rejects the document (a defect)
 */
export function writeDocument<T>(verb: ReportVerb, report: Report<T>, format: DocumentFormat): Report<T> {
  const entry = reportShapeFor(verb);
  const written = publishedReport(verb, report);
  if (format === 'text') {
    const text = entry.renderText === undefined
      ? renderReportText(written, entry.examined.unit)
      : entry.renderText(written);
    if (text !== '') process.stdout.write(text);
  } else {
    writeStructured(written, format);
  }
  return written;
}

/**
 * Publish a report verb's document and end on the code it derives.
 *
 * @param verb - The registered verb
 * @param report - The document as the verb built it
 * @param format - How to render it
 */
export function endWithReport<T>(verb: ReportVerb, report: Report<T>, format: DocumentFormat): never {
  process.exit(exitCodeForReport(writeDocument(verb, report, format)));
}

/** What finished before a refusal: the work a partial run already did. */
export interface FinishedWork {
  readonly examined: number;
  readonly findings: readonly Finding[];
  readonly data: unknown;
}

/** The explicit "nothing finished" — spelled out at the call site, never defaulted. */
export const NOTHING_FINISHED: FinishedWork = Object.freeze({ examined: 0, findings: [], data: null });

/**
 * Publish the envelope's error branch — the run could not do its job — with
 * whatever finished, and end on `ERROR`.
 *
 * The message also goes to stderr, where a human reads it; `INTERNAL_ERROR`
 * adds the stack, since that one is VAT's defect to report, and under
 * `--debug` every refusal does — the flag exists to name the throw site.
 *
 * @param verb - The registered verb
 * @param code - Which refusal: `USAGE_INVALID` for the invocation's mistake,
 *   `INPUT_UNREADABLE` for an input that cannot be read, `INTERNAL_ERROR` only
 *   for a failure VAT did not anticipate
 * @param error - The thrown value, or the message
 * @param format - How to render the document
 * @param gate - The gate the run was judged by
 * @param finished - The work that finished, or {@link NOTHING_FINISHED}
 */
export function endWithRefusal(
  verb: ReportVerb,
  code: RefusalCode,
  error: unknown,
  format: DocumentFormat,
  gate: Gate,
  finished: FinishedWork,
): never {
  process.exit(exitCodeForReport(writeDocument(verb, refusalReport(code, error, gate, finished), format)));
}

/**
 * A refusal's human half: its message on stderr — the code's own description
 * when the thrown value carries none — plus the stack for a VAT defect, or for
 * any refusal under `--debug`, which exists to name the throw site.
 *
 * @returns The message the published document carries
 */
function announceRefusal(code: RefusalCode, error: unknown): string {
  const raw = errorMessageOf(error);
  const message = raw === '' ? CODE_REGISTRY[code].description : withFsFaultRemedy(raw, error);
  process.stderr.write(`${message}\n`);
  if (code === 'INTERNAL_ERROR' || debugDiagnosticsEnabled()) process.stderr.write(`${errorDiagnostics(error)}\n`);
  return message;
}

/**
 * The envelope's error branch for a refusal, with its human half already on
 * stderr — what {@link endWithRefusal} writes, for the lane that hands the
 * report on instead (a phase an orchestrator folds, or an orchestrator's own
 * refusal).
 *
 * @param code - Which refusal (see {@link endWithRefusal})
 * @param error - The thrown value, or the message
 * @param gate - The gate the run was judged by
 * @param finished - The work that finished, or {@link NOTHING_FINISHED}
 * @returns The error report, not yet published
 */
export function refusalReport(code: RefusalCode, error: unknown, gate: Gate, finished: FinishedWork): Report<unknown> {
  const message = announceRefusal(code, error);
  return buildErrorReport({
    error: { code, message },
    gate,
    examined: finished.examined,
    findings: [...finished.findings, ...leftoverFindingsOf(error)],
    data: finished.data,
  });
}

/**
 * What the failure path could not clean up — a temporary directory, a staged tree —
 * recorded beside the thrown error (`suppressedFaultsOf`), as warnings naming each.
 * Recorded beside, never on its cause chain: a leftover is never the run's refusal.
 */
export function leftoverFindingsOf(error: unknown): Array<ValidationIssue & Finding> {
  return suppressedFaultsOf(error).map((fault) => {
    process.stderr.write(`warning: ${errorMessageOf(fault)}\n`);
    return leftoverIssueOf(fault);
  });
}

/**
 * The {@link leftoverIssue} a failure to remove something stands for: its message, and — for a
 * classified fault — the path it names (the entry left).
 *
 * @param fault - What the removal threw: a parked entry an uninstall or a clear could not delete
 *   (`applyTreePlanOrLeftover`'s `leftover`), or a suppressed fault beside a refusal
 */
export function leftoverIssueOf(fault: unknown): ValidationIssue & Finding {
  return leftoverIssue(errorMessageOf(fault), isFsFaultError(fault) ? fault.path : undefined);
}

/**
 * Something a run made and could not remove — a temporary directory, a staged or parked tree —
 * as the ONE warning every lane names it with ({@link TREE_CLEANUP_INCOMPLETE_CODE}), whether the
 * run then refused or finished.
 *
 * @param message - What was left, and why it stayed
 * @param path - The entry left, when known: its `link`
 */
export function leftoverIssue(message: string, path: string | undefined): ValidationIssue & Finding {
  return {
    code: TREE_CLEANUP_INCOMPLETE_CODE,
    severity: 'warning',
    message,
    // `link`, never `location`: a report's location is project-relative, and this is an absolute path (a temp dir, a staged tree).
    ...(path === undefined ? {} : { link: path }),
    fix: 'Remove what the message names yourself, making it writable first if the OS refused; nothing VAT made uses it.',
  };
}

/** A document another `vat` process wrote, checked to be its verb's, with the report it parses to. */
export interface ForwardedDocument {
  readonly text: string;
  readonly report: Report<unknown>;
}

/**
 * Read a report verb's document another `vat` process already wrote — a
 * supervised child — checking it IS that verb's document: parsed in the format
 * it was asked for and validated against the published schema.
 *
 * @param verb - The registered verb whose document `text` claims to be
 * @param text - The document as the child wrote it
 * @param format - The format the child was asked for
 * @returns The text with the report it parses to, for {@link endWithForwardedDocument}
 * @throws When `text` does not parse, or its schema rejects it — a truncated
 *   write among them, which the caller decides how to report
 */
export function readForwardedDocument(verb: ReportVerb, text: string, format: Exclude<DocumentFormat, 'text'>): ForwardedDocument {
  const parsed: unknown = format === 'json' ? JSON.parse(text) : parseYaml(text);
  reportShapeFor(verb).schema.parse(parsed);
  return { text, report: parsed as Report<unknown> };
}

/**
 * Publish a forwarded document byte for byte and end on the code the document
 * derives — never on the code the process that wrote it happened to exit with.
 *
 * @param document - What {@link readForwardedDocument} accepted
 */
export function endWithForwardedDocument(document: ForwardedDocument): never {
  writeStdoutSync(document.text);
  process.exit(exitCodeForReport(document.report));
}

/**
 * Publish an externally owned payload verbatim and end on the code its
 * registered adapter maps `outcome` to.
 *
 * @param verb - A verb of an `external` entry
 * @param payload - The payload as its owner shaped it
 * @param format - How to render it (`text` renders YAML)
 * @param outcome - What the external write did
 */
export function writeExternalDocument(verb: ExternalVerb, payload: unknown, format: DocumentFormat, outcome: ExternalOutcome): never {
  writeStructured(payload, format);
  process.exit(exitCodeForExternal(verb, outcome));
}

/**
 * End an external verb whose run threw: publish `{ error: { code, message } }`
 * — the one failure payload every external verb shares, since the payload it
 * would have passed through never arrived — and end on the code its adapter
 * maps `failed` to. The code is the thrown value's own ({@link refusalCodeOf}):
 * a missing key or a bad argument is `USAGE_INVALID`, a refused or unanswered
 * API call `EXTERNAL_API_FAILED`, anything uncoded `INTERNAL_ERROR`.
 *
 * @param verb - A verb of an `external` entry
 * @param error - What the run threw
 * @param format - How to render the payload
 */
export function endWithExternalRefusal(verb: ExternalVerb, error: unknown, format: DocumentFormat): never {
  const code = refusalCodeOf(error);
  const message = announceRefusal(code, error);
  writeExternalDocument(verb, { error: { code, message } }, format, { kind: 'failed', cause: message });
}

/**
 * The one serializer for a `legacy` entry's document: unvalidated, and typed
 * to the legacy verbs so no report verb can take this path.
 *
 * @param _verb - A verb of a `legacy` entry
 * @param document - The legacy document
 * @param format - How to render it
 * @param text - The verb's own `--format text` rendering, written as-is; with
 *   none (a refusal has no human rendering of its own) `text` renders YAML.
 *   Required, so a caller says which it means
 */
export function writeLegacyDocument(_verb: LegacyVerb, document: unknown, format: DocumentFormat, text: string | undefined): void {
  // The verb's TYPE is the guarantee — only a legacy verb compiles here.
  if (format === 'text' && text !== undefined) {
    // Synchronously, as `claude context` always wrote it: its text can run long and the verb exits straight after.
    writeStdoutSync(text);
    return;
  }
  writeStructured(document, format);
}

/** Validate a payload against its artifact entry's schema, when it declares one. */
function validatedArtifact(name: string, channel: 'stdout' | 'file', payload: unknown): void {
  artifactShapeFor(name, channel).schema?.parse(payload);
}

/**
 * Publish a stdout artifact — a config to paste, a file's text — and nothing else.
 *
 * @param name - The registered stdout artifact
 * @param payload - The artifact; a string for `raw`
 * @param format - `yaml` / `json`, or `raw` to write a string as-is
 */
export function writeArtifact(name: string, payload: unknown, format: Exclude<DocumentFormat, 'text'> | 'raw'): void {
  validatedArtifact(name, 'stdout', payload);
  if (format === 'raw') {
    process.stdout.write(String(payload));
    return;
  }
  writeStructured(payload, format);
}

/**
 * Write a registered file artifact: YAML for a `.yaml`/`.yml` path, JSON otherwise.
 *
 * @param name - The registered file artifact
 * @param path - Where to write it
 * @param payload - The artifact
 */
export function writeArtifactFile(name: string, path: string, payload: unknown): void {
  validatedArtifact(name, 'file', payload);
  const text = /\.ya?ml$/.test(path) ? renderYamlDocument(payload) : `${JSON.stringify(payload, null, 2)}\n`;
  writeFileSync(path, text, 'utf-8');
}
