/**
 * Unified validation framework.
 *
 * Three composable stages that turn raw validator issues into the final
 * emitted set:
 *  - `applyAllowFilter` — suppress issues matched by `validation.allow`
 *    entries, tracking expired/unused allowances.
 *  - `resolveSeverity` — resolve each registry code's severity against
 *    `validation.severity` overrides (falling back to the registry default).
 *  - `runValidationFramework` — orchestrates the two above, drops `ignore`d
 *    issues, and synthesizes ALLOW_EXPIRED / ALLOW_UNUSED meta-issues.
 *
 * Non-registry codes (InfoCode / NonOverridableCode) deliberately bypass
 * severity resolution and pass through unchanged.
 */

import picomatch from 'picomatch';

import { CODE_REGISTRY, type IssueCode, type IssueSeverity } from './validation-codes.js';
import type { AllowEntry, ValidationConfig } from './validation-config.js';
import type { ValidationIssue } from './validation-issue.js';

// The Zod-inferred `ValidationConfig` (from validation-config.ts) is the single
// canonical config type. The framework's narrower input types derive from it so
// a parsed config is directly assignable to `runValidationFramework`.
export type { ValidationConfig } from './validation-config.js';
export type SeverityConfig = Pick<ValidationConfig, 'severity'>;
export type AllowConfig = Pick<ValidationConfig, 'allow'>;

// ---------------------------------------------------------------------------
// Severity resolution
// ---------------------------------------------------------------------------

export function resolveSeverity(code: IssueCode, config: SeverityConfig): IssueSeverity {
  const override = config.severity?.[code];
  if (override === 'error' || override === 'warning' || override === 'info' || override === 'ignore') {
    return override;
  }
  return CODE_REGISTRY[code].defaultSeverity;
}

// ---------------------------------------------------------------------------
// Allow filter
// ---------------------------------------------------------------------------

export interface AllowRecord {
  code: IssueCode;
  location: string;
  reason: string;
  expires?: string | undefined;
}

export interface UnusedRecord {
  code: IssueCode;
  paths: string[];
  reason: string;
  expires?: string | undefined;
}

export interface ExpiredRecord {
  code: IssueCode;
  reason: string;
  expires: string;
  /** Locations (matched issue paths) this entry is currently suppressing, if any. */
  matchedLocations: string[];
}

export interface AllowFilterResult {
  emitted: ValidationIssue[];
  allowed: AllowRecord[];
  expired: ExpiredRecord[];
  unused: UnusedRecord[];
}

interface CompiledEntry {
  entry: AllowEntry;
  match: (p: string) => boolean;
  used: boolean;
}

function isExpired(expires: string | undefined, now: Date): boolean {
  if (!expires) return false;
  const parsed = Date.parse(expires);
  return Number.isFinite(parsed) && parsed < now.getTime();
}

function buildMatchers(
  allowByCode: Partial<Record<IssueCode, AllowEntry[]>>,
): Map<IssueCode, CompiledEntry[]> {
  const matchers = new Map<IssueCode, CompiledEntry[]>();
  for (const [code, entries] of Object.entries(allowByCode) as Array<[IssueCode, AllowEntry[] | undefined]>) {
    if (!entries) continue;
    // `dot: true` — adopter paths often contain dotfile segments (.claude/,
    // .worktrees/, .config/). Without it `picomatch('**/*')` silently fails
    // to match any path traversing a dotfile dir, so allow entries are
    // never applied. The path was given to us by the validator; we are not
    // doing glob discovery on the filesystem.
    matchers.set(code, entries.map(e => ({ entry: e, match: picomatch(e.paths, { dot: true }), used: false })));
  }
  return matchers;
}

function collectExpiredAndUnused(
  matchers: Map<IssueCode, CompiledEntry[]>,
  allowed: AllowRecord[],
  now: Date,
): { expired: ExpiredRecord[]; unused: UnusedRecord[] } {
  const expired: ExpiredRecord[] = [];
  const unused: UnusedRecord[] = [];

  for (const [code, list] of matchers) {
    for (const m of list) {
      if (isExpired(m.entry.expires, now)) {
        const matchedLocations = allowed
          .filter(a => a.code === code && a.reason === m.entry.reason)
          .map(a => a.location);
        expired.push({
          code,
          reason: m.entry.reason,
          expires: m.entry.expires as string,
          matchedLocations,
        });
      }
      if (!m.used) {
        const unusedRecord: UnusedRecord = {
          code,
          paths: m.entry.paths,
          reason: m.entry.reason,
        };
        if (m.entry.expires !== undefined) {
          unusedRecord.expires = m.entry.expires;
        }
        unused.push(unusedRecord);
      }
    }
  }

  return { expired, unused };
}

export function applyAllowFilter(
  issues: readonly ValidationIssue[],
  config: AllowConfig,
  now: Date = new Date(),
): AllowFilterResult {
  const emitted: ValidationIssue[] = [];
  const allowed: AllowRecord[] = [];

  const matchers = buildMatchers(config.allow ?? {});

  for (const issue of issues) {
    const code = issue.code as IssueCode;
    const byCode = matchers.get(code);
    const location = issue.location ?? '';
    const hit = byCode?.find(m => m.match(location));
    if (hit) {
      hit.used = true;
      const record: AllowRecord = {
        code,
        location,
        reason: hit.entry.reason,
      };
      if (hit.entry.expires !== undefined) {
        record.expires = hit.entry.expires;
      }
      allowed.push(record);
    } else {
      emitted.push(issue);
    }
  }

  const { expired, unused } = collectExpiredAndUnused(matchers, allowed, now);

  return { emitted, allowed, expired, unused };
}

// ---------------------------------------------------------------------------
// Framework orchestration
// ---------------------------------------------------------------------------

export interface FrameworkResult {
  /** Issues the consumer should surface (severity resolved; ignores dropped). */
  emitted: ValidationIssue[];
  /** Issues suppressed by an allow entry (for verbose display). */
  allowed: Array<{ code: IssueCode; location: string; reason: string; expires?: string | undefined }>;
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

function metaIssue(code: 'ALLOW_EXPIRED' | 'ALLOW_UNUSED', message: string, location: string): ValidationIssue {
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
  expired: ReturnType<typeof applyAllowFilter>['expired'],
  config: ValidationConfig,
  emitted: ValidationIssue[],
): void {
  for (const e of expired) {
    const msg = `Allow entry for ${e.code} expired on ${e.expires} (reason: ${e.reason}).`;
    const raw = metaIssue('ALLOW_EXPIRED', msg, `validation.allow.${e.code}`);
    const final = finalize(raw, config);
    if (final) emitted.push(final);
  }
}

function emitUnusedMeta(
  unused: ReturnType<typeof applyAllowFilter>['unused'],
  config: ValidationConfig,
  emitted: ValidationIssue[],
): void {
  for (const u of unused) {
    const msg = `Allow entry for ${u.code} matched no issues (paths: ${u.paths.join(', ')}).`;
    const raw = metaIssue('ALLOW_UNUSED', msg, `validation.allow.${u.code}`);
    const final = finalize(raw, config);
    if (final) emitted.push(final);
  }
}

export function runValidationFramework(
  rawIssues: readonly ValidationIssue[],
  config: ValidationConfig,
  now: Date = new Date(),
): FrameworkResult {
  // 1. Allow filter against raw issues (before severity resolution — allow is
  //    indifferent to severity).
  const filtered = applyAllowFilter(rawIssues, config, now);

  // 2. Resolve severities and drop ignored issues.
  const emitted: ValidationIssue[] = [];
  for (const i of filtered.emitted) {
    const final = finalize(i, config);
    if (final) emitted.push(final);
  }

  // 3. Emit ALLOW_EXPIRED for each expired entry (severity from config).
  emitExpiredMeta(filtered.expired, config, emitted);

  // 4. Emit ALLOW_UNUSED for entries that matched nothing.
  emitUnusedMeta(filtered.unused, config, emitted);

  const allowed: AllowRecord[] = filtered.allowed;

  return {
    emitted,
    allowed,
    hasErrors: emitted.some(i => i.severity === 'error'),
  };
}
