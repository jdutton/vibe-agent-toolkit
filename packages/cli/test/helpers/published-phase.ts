/**
 * What a phase's command would publish, without publishing it: the phase's
 * report through the writer's run-integrity pass and its registered schema,
 * and the exit code that document derives.
 *
 * A phase hands back its report BEFORE that pass (an orchestrator judges zero
 * examined on the whole run), so a test of the command lane goes through here.
 */

import { exitCodeForReport, type ExitCodeValue, type Finding, type Report, type SeverityCounts } from '@vibe-agent-toolkit/schema';
import * as YAML from 'yaml';

import { ORCHESTRATOR_REPORT_SCHEMA, PACKAGED_CONTENT_REPORT_SCHEMA } from '../../src/commands/orchestrator-schema.js';
import { DATALESS_PHASE_REPORT_SCHEMA, type PhaseOutcome, type PhaseReportSchema } from '../../src/commands/phase-utils.js';
import { reportShapeFor, type ReportVerb } from '../../src/report-schemas.js';
import { publishedReport } from '../../src/utils/document-writer.js';

/**
 * @param verb - The phase's own registered verb
 * @param outcome - What the phase returned
 * @returns The published document, typed as the caller's report, and its exit code
 */
export function publishedPhase<T = Report<unknown>>(verb: ReportVerb, outcome: PhaseOutcome): { exitCode: ExitCodeValue; document: T } {
  const document = publishedReport(verb, outcome.report);
  return { exitCode: exitCodeForReport(document), document: document as unknown as T };
}

/** Which orchestrator published a document — `skills` means a different verb in `vat build`. */
type Orchestrator = 'build' | 'validate' | 'verify';

/**
 * The report schema that describes a phase's `data`, chosen by the phase's
 * NAME — an oracle independent of the `schema` each production `Phase` is
 * wired with, so a phase wired to the wrong schema cannot vouch for itself.
 */
function ownSchemaOf(orchestrator: Orchestrator, name: string): PhaseReportSchema | undefined {
  if (name === 'resources') return reportShapeFor('resources validate').schema;
  if (name === 'skills') return reportShapeFor(orchestrator === 'build' ? 'skills build' : 'skills validate').schema;
  if (name === 'claude') return reportShapeFor('claude plugin build').schema;
  if (name.startsWith('marketplace:')) return reportShapeFor('claude marketplace validate').schema;
  if (name === 'packaged-content') return PACKAGED_CONTENT_REPORT_SCHEMA;
  if (['files-config-dests', 'consistency', 'shipped-links'].includes(name)) return DATALESS_PHASE_REPORT_SCHEMA;
  return undefined;
}

/**
 * Every phase of an orchestrator's published document whose `data` its own
 * schema does NOT describe, as `<name>: <why>` — `[]` when each one does.
 *
 * The orchestrator's schema holds `data.phases[i].data` as `unknown`; this
 * parses each with the `data` schema of that phase's own report (nullable for
 * a phase that did not finish, as the error branch is).
 */
export function phaseDataMismatches(document: { data: unknown }, orchestrator: Orchestrator): string[] {
  const phases = (document.data as { phases: { name: string; status: string; data: unknown }[] } | null)?.phases ?? [];
  const mismatches: string[] = [];
  for (const phase of phases) {
    const schema = ownSchemaOf(orchestrator, phase.name);
    if (schema === undefined) {
      mismatches.push(`${phase.name}: no schema is known for this phase`);
      continue;
    }
    const data = schema.innerType().options[0].shape.data;
    const parsed = (phase.status === 'error' ? data.nullable() : data).safeParse(phase.data);
    if (!parsed.success) mismatches.push(`${phase.name}: ${parsed.error.message}`);
  }
  return mismatches;
}

/** An orchestrator's published document, as a system test reads it. */
interface OrchestratorDocument {
  status: string;
  examined: number;
  summary: SeverityCounts;
  findings: Finding[];
  error?: { code: string; message: string };
  data: {
    phases: { name: string; status: string; examined: number; summary: SeverityCounts; error?: { code: string; message: string }; data: unknown }[];
  } | null;
}

/** The orchestrator's document on stdout, parsed with its registered schema (a mismatch throws). */
export function orchestratorReportOf(stdout: string): OrchestratorDocument {
  return ORCHESTRATOR_REPORT_SCHEMA.parse(YAML.parse(stdout)) as OrchestratorDocument;
}
