/**
 * Comparing a warm run's report with its store-off oracle when the oracle may have been
 * refused a parse UNDER LOAD.
 *
 * A parse stopped at its `timeMs` or `heapMb` limit depends on the machine and what else it is
 * doing, not on the document (`parse-pool.ts`, `#refuseUnderLoad`, counted `parse.refused.load`
 * and never compared exactly). A store-off run that parses beside other runs can be refused one
 * that a warm run, served from the store, never parses at all. Such a finding is dropped from
 * both sides before the comparison — but on each side no more files than that run itself counted
 * (summed over its processes), so the filter cannot hide a real difference.
 */

import { ParseLimitError } from '@vibe-agent-toolkit/resources';
import { expect } from 'vitest';
import { parse as parseYaml } from 'yaml';

/** The two limits whose breach is the load's, not the document's. */
export const LOAD_LIMITS = ['timeMs', 'heapMb'] as const;

/**
 * The refusal clause a breach of `limit` is said in, as the product spells it (`ParseLimitError`
 * builds its message from `limitRefusalClause`), with its first letter lowered as a lane quotes it.
 *
 * @param limit - The limit crossed
 * @param bound - The bound as spelled
 * @returns e.g. `its parse was stopped at its timeMs limit (30000 ms wall clock)`
 */
export function loadRefusalClause(limit: (typeof LOAD_LIMITS)[number], bound: string): string {
  const sentence = new ParseLimitError(limit, 0, undefined, bound).message;
  return `${sentence.charAt(0).toLowerCase()}${sentence.slice(1, -1)}`;
}

/** Each load limit's clause up to its bound, so wording drift in the product reds the unit test. */
const LOAD_REFUSAL_PREFIXES = LOAD_LIMITS.map((limit) => loadRefusalClause(limit, '').slice(0, -1));

/** One run's answer, and how many load refusals it counted. */
export interface RunAnswer {
  readonly status: number | null;
  /** Its report on stdout. */
  readonly stdout: string;
  /** `parse.refused.load` summed over every process of the run, its checks child included. */
  readonly loadRefusals: number;
}

/** Whether a published finding is a parse refused at a load-dependent limit. */
function isLoadRefusal(finding: unknown): boolean {
  const { code, message } = finding as { code?: unknown; message?: unknown };
  return (
    code === 'RESOURCE_PARSE_LIMIT_EXCEEDED' &&
    typeof message === 'string' &&
    LOAD_REFUSAL_PREFIXES.some((prefix) => message.includes(prefix))
  );
}

/**
 * A report's findings, with its load refusals apart, counted by the file refused: `vat validate`
 * reports one refused file once per lane that reads it (resources and skills), and the run
 * counts the refusal once.
 */
function splitFindings(stdout: string): { kept: string; dropped: number } {
  const findings = (parseYaml(stdout) as { findings?: unknown[] }).findings;
  const kept = findings?.filter((finding) => !isLoadRefusal(finding));
  const refused = new Set(findings?.filter((finding) => isLoadRefusal(finding)).map((finding) => (finding as { location?: unknown }).location));
  return { kept: JSON.stringify(kept), dropped: refused.size };
}

/**
 * Assert a run's dropped load refusals are ones it counted: no more refused files than the
 * `parse.refused.load` its processes counted. A count with nothing dropped is allowed (a checks
 * child refused under load may leave no finding); a dropped file with nothing counted is not, so
 * the filter cannot hide a finding the run did not refuse under load.
 *
 * @param label - Which run, for the failure message
 * @param dropped - Files whose load refusal was dropped from its report
 * @param counted - Load refusals its processes counted
 */
function expectAccounted(label: string, dropped: number, counted: number): void {
  expect(dropped, `${label}: every load refusal dropped is one the run counted, file by file`).toBeLessThanOrEqual(counted);
}

/**
 * Assert a warm run answers as its store-off oracle does, load refusals aside: on each side the
 * dropped findings are load refusals that side counted, and the exit code and every other finding
 * are equal. Either side may be refused under load: the warm run's checks child re-derives its
 * tree beside the other runs.
 *
 * @param warm - The run served from the store
 * @param off - The store-off run it must answer as
 */
export function expectAnswersAsStoreOff(warm: RunAnswer, off: RunAnswer): void {
  const warmFindings = splitFindings(warm.stdout);
  const offFindings = splitFindings(off.stdout);
  expectAccounted('warm', warmFindings.dropped, warm.loadRefusals);
  expectAccounted('store-off', offFindings.dropped, off.loadRefusals);
  expect({ status: warm.status, findings: warmFindings.kept }, 'warm answers as store-off does').toEqual({
    status: off.status,
    findings: offFindings.kept,
  });
}
