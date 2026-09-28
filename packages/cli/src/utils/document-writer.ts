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
} from '@vibe-agent-toolkit/schema';

import {
  artifactShapeFor,
  exitCodeForExternal,
  reportShapeFor,
  type DocumentFormat,
  type ExternalOutcome,
  type LegacyVerb,
  type ReportVerb,
} from '../report-schemas.js';

import { errorMessageOf } from './command-refusal.js';
import { debugDiagnosticsEnabled } from './debug-diagnostics.js';
import { renderYamlDocument, writeJsonOutput, writeYamlOutput } from './output.js';
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

/** Write `document` in a structured format — `text` has no structure, so it is YAML. */
function writeStructured(document: unknown, format: DocumentFormat): void {
  if (format === 'json') {
    writeJsonOutput(document);
  } else {
    writeYamlOutput(document);
  }
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
  const written = withRunIntegrity(report, entry.examined);
  entry.schema.parse(written);
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
  const raw = errorMessageOf(error);
  const message = raw === '' ? CODE_REGISTRY[code].description : raw;
  process.stderr.write(`${message}\n`);
  // The stack always for a VAT defect; for a user's refusal only under `--debug`,
  // which exists to name the throw site.
  if (code === 'INTERNAL_ERROR' || debugDiagnosticsEnabled()) process.stderr.write(`${errorDiagnostics(error)}\n`);
  const report = buildErrorReport({
    error: { code, message },
    gate,
    examined: finished.examined,
    findings: finished.findings,
    data: finished.data,
    durationMs: undefined,
  });
  process.exit(exitCodeForReport(writeDocument(verb, report, format)));
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
export function writeExternalDocument(verb: string, payload: unknown, format: DocumentFormat, outcome: ExternalOutcome): never {
  writeStructured(payload, format);
  process.exit(exitCodeForExternal(verb, outcome));
}

/**
 * The one serializer for a `legacy` entry's document: unvalidated, and typed
 * to the legacy verbs so no report verb can take this path.
 *
 * @param _verb - A verb of a `legacy` entry
 * @param document - The legacy document
 * @param format - How to render it (`text` renders YAML)
 */
export function writeLegacyDocument(_verb: LegacyVerb, document: unknown, format: DocumentFormat): void {
  // The verb's TYPE is the guarantee — only a legacy verb compiles here.
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
