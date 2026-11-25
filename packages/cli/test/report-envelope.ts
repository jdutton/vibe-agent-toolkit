/**
 * The two halves of a report envelope a test reads after the type system has
 * lost which branch the run took.
 *
 * Only the `error` branch may carry `data: null`, and only it carries `error`,
 * so a test reading either narrows through here and fails loudly, naming the
 * status, when the run took a different branch.
 */

import type { ReportError } from '@vibe-agent-toolkit/schema';

/**
 * @param report - Any report envelope (or a document typed like one)
 * @returns Its `data`, proven non-null
 */
export function reportData<T>(report: { status?: string; data: T | null }): T {
  if (report.data === null) {
    throw new Error(`expected the report to carry data, but it has none (status: ${report.status ?? 'unknown'})`);
  }
  return report.data;
}

/** Why a report's run refused, or `undefined` when it completed: only the `error` branch carries one. */
export function refusalOf(
  report: { readonly status: 'ok' | 'findings' } | { readonly status: 'error'; readonly error: ReportError },
): ReportError | undefined {
  return report.status === 'error' ? report.error : undefined;
}

/**
 * @param report - Any report envelope
 * @returns The `error` of a refused (`status: error`) run
 */
export function reportError(report: { status: string; error?: ReportError }): ReportError {
  if (report.status !== 'error' || report.error === undefined) {
    throw new Error(`expected a refused report carrying an error, but its status is ${report.status}`);
  }
  return report.error;
}
