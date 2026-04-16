import { applyAcceptFilter, type AcceptConfig, type AcceptRecord } from './accept-filter.js';
import { CODE_REGISTRY, type IssueCode } from './code-registry.js';
import { resolveSeverity, type SeverityConfig } from './severity-resolver.js';
import type { ValidationIssue } from './types.js';

export interface ValidationConfig extends SeverityConfig, AcceptConfig {}

export interface FrameworkResult {
  /** Issues the consumer should surface (severity resolved; ignores dropped). */
  emitted: ValidationIssue[];
  /** Issues suppressed by an accept entry (for verbose display). */
  accepted: Array<{ code: IssueCode; location: string; reason: string; expires?: string | undefined }>;
  /** True when any emitted issue has resolved severity 'error'. */
  hasErrors: boolean;
}

function finalize(issue: ValidationIssue, config: ValidationConfig): ValidationIssue | null {
  const code = issue.code as IssueCode;
  const entry = CODE_REGISTRY[code];
  if (!entry) {
    // Not a registry code — return as-is (non-overridable / info codes bypass framework).
    return issue;
  }
  const resolved = resolveSeverity(code, config);
  if (resolved === 'ignore') return null;
  return { ...issue, severity: resolved, reference: entry.reference };
}

function metaIssue(code: 'ACCEPTANCE_EXPIRED' | 'ACCEPTANCE_UNUSED', message: string, location: string): ValidationIssue {
  const entry = CODE_REGISTRY[code];
  return {
    severity: entry.defaultSeverity,
    code,
    message,
    location,
    fix: entry.fix,
    reference: entry.reference,
  };
}

function emitExpiredMeta(
  expired: ReturnType<typeof applyAcceptFilter>['expired'],
  config: ValidationConfig,
  emitted: ValidationIssue[],
): void {
  for (const e of expired) {
    const msg = `Acceptance for ${e.code} expired on ${e.expires} (reason: ${e.reason}).`;
    const raw = metaIssue('ACCEPTANCE_EXPIRED', msg, `validation.accept.${e.code}`);
    const final = finalize(raw, config);
    if (final) emitted.push(final);
  }
}

function emitUnusedMeta(
  unused: ReturnType<typeof applyAcceptFilter>['unused'],
  config: ValidationConfig,
  emitted: ValidationIssue[],
): void {
  for (const u of unused) {
    const msg = `Accept entry for ${u.code} matched no issues (paths: ${u.paths.join(', ')}).`;
    const raw = metaIssue('ACCEPTANCE_UNUSED', msg, `validation.accept.${u.code}`);
    const final = finalize(raw, config);
    if (final) emitted.push(final);
  }
}

export function runValidationFramework(
  rawIssues: readonly ValidationIssue[],
  config: ValidationConfig,
  now: Date = new Date(),
): FrameworkResult {
  // 1. Accept filter against raw issues (before severity resolution — accept is
  //    indifferent to severity).
  const filtered = applyAcceptFilter(rawIssues, config, now);

  // 2. Resolve severities and drop ignored issues.
  const emitted: ValidationIssue[] = [];
  for (const i of filtered.emitted) {
    const final = finalize(i, config);
    if (final) emitted.push(final);
  }

  // 3. Emit ACCEPTANCE_EXPIRED for each expired entry (severity from config).
  emitExpiredMeta(filtered.expired, config, emitted);

  // 4. Emit ACCEPTANCE_UNUSED for entries that matched nothing.
  emitUnusedMeta(filtered.unused, config, emitted);

  const accepted: AcceptRecord[] = filtered.accepted;

  return {
    emitted,
    accepted,
    hasErrors: emitted.some(i => i.severity === 'error'),
  };
}
