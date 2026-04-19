/**
 * Shared capability-observation derivation.
 *
 * Rolls `EvidenceRecord`s up into `CAPABILITY_*` observations. Callers
 * supply the local-shell pattern-ID set (which differs per subject — skills
 * check fewer patterns than full plugins) and a subject label for summary
 * wording.
 */

import {
  detectInterpreter,
  extractMcpCommandFromMatchText,
} from './interpreter-detection.js';
import type { EvidenceRecord, Observation } from './types.js';

/** Subject of derivation — controls observation summary wording. */
export type DerivationSubject = 'skill' | 'plugin';

export interface DeriveObservationsOptions {
  /** Pattern IDs that imply CAPABILITY_LOCAL_SHELL for this subject. */
  localShellPatternIds: ReadonlySet<string>;
  /** Subject label used in observation summaries. */
  subject: DerivationSubject;
}

/** External-CLI pattern IDs paired with their binary name. */
export const EXTERNAL_CLI_BINARIES: ReadonlyArray<{ binary: string; patternId: string }> = [
  { binary: 'az', patternId: 'EXTERNAL_CLI_AZ' },
  { binary: 'aws', patternId: 'EXTERNAL_CLI_AWS' },
  { binary: 'gcloud', patternId: 'EXTERNAL_CLI_GCLOUD' },
  { binary: 'kubectl', patternId: 'EXTERNAL_CLI_KUBECTL' },
  { binary: 'docker', patternId: 'EXTERNAL_CLI_DOCKER' },
  { binary: 'terraform', patternId: 'EXTERNAL_CLI_TERRAFORM' },
  { binary: 'gh', patternId: 'EXTERNAL_CLI_GH' },
  { binary: 'op', patternId: 'EXTERNAL_CLI_OP' },
];

const BROWSER_AUTH_PATTERN_IDS: ReadonlySet<string> = new Set([
  'BROWSER_AUTH_MSAL_PYTHON_IMPORT',
  'BROWSER_AUTH_MSAL_JS_IMPORT',
  'BROWSER_AUTH_AZ_LOGIN',
  'BROWSER_AUTH_GCLOUD_LOGIN',
  'BROWSER_AUTH_AWS_SSO_LOGIN',
  'BROWSER_AUTH_WEBBROWSER_OPEN',
]);

/**
 * Classify a single evidence record as contributing to a specific external-CLI
 * binary (e.g. via `EXTERNAL_CLI_*` patterns, or an `MCP_SERVER_COMMAND` whose
 * command field is a known interpreter). Returns `undefined` if the record
 * does not contribute.
 */
function externalCliBinaryFor(record: EvidenceRecord): string | undefined {
  const explicit = EXTERNAL_CLI_BINARIES.find(b => b.patternId === record.patternId);
  if (explicit) return explicit.binary;
  if (record.patternId !== 'MCP_SERVER_COMMAND') return undefined;
  const command = extractMcpCommandFromMatchText(record.matchText);
  return command === undefined ? undefined : detectInterpreter(command);
}

function aggregateExternalCliEvidence(
  evidence: readonly EvidenceRecord[],
): Map<string, EvidenceRecord[]> {
  const cliByBinary = new Map<string, EvidenceRecord[]>();
  for (const e of evidence) {
    const binary = externalCliBinaryFor(e);
    if (!binary) continue;
    const existing = cliByBinary.get(binary);
    if (existing) {
      existing.push(e);
    } else {
      cliByBinary.set(binary, [e]);
    }
  }
  return cliByBinary;
}

function dedupePatternIds(records: readonly EvidenceRecord[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of records) {
    if (seen.has(r.patternId)) continue;
    seen.add(r.patternId);
    out.push(r.patternId);
  }
  return out;
}

export function deriveObservationsFromEvidence(
  evidence: readonly EvidenceRecord[],
  options: DeriveObservationsOptions,
): Observation[] {
  const subjectCap = options.subject === 'skill' ? 'Skill' : 'Plugin';
  const out: Observation[] = [];

  const localShell = evidence.filter(e => options.localShellPatternIds.has(e.patternId));
  if (localShell.length > 0) {
    out.push({
      code: 'CAPABILITY_LOCAL_SHELL',
      summary: `${subjectCap} requires a local shell environment.`,
      supportingEvidence: dedupePatternIds(localShell),
    });
  }

  const cliByBinary = aggregateExternalCliEvidence(evidence);
  const sortedBinaries = [...cliByBinary.keys()].sort((a, b) => a.localeCompare(b));
  for (const binary of sortedBinaries) {
    const records = cliByBinary.get(binary);
    if (!records) continue;
    out.push({
      code: 'CAPABILITY_EXTERNAL_CLI',
      summary: `${subjectCap} invokes external CLI: ${binary}.`,
      payload: { binary },
      supportingEvidence: dedupePatternIds(records),
    });
  }

  const browserAuth = evidence.filter(e => BROWSER_AUTH_PATTERN_IDS.has(e.patternId));
  if (browserAuth.length > 0) {
    out.push({
      code: 'CAPABILITY_BROWSER_AUTH',
      summary: `${subjectCap} requires an interactive browser authentication flow.`,
      supportingEvidence: dedupePatternIds(browserAuth),
    });
  }

  return out;
}
