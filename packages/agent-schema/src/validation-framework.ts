/**
 * Unified validation framework.
 *
 * Three composable stages that turn raw validator issues into the final
 * emitted set:
 *  - `applyAllowFilter` — suppress issues matched by `validation.allow`
 *    entries, reporting per-entry usage and expired allowances.
 *  - `resolveSeverity` — resolve each registry code's severity against
 *    `validation.severity` overrides (falling back to the registry default).
 *  - `runValidationFramework` — orchestrates the two above, drops `ignore`d
 *    issues, and synthesizes ALLOW_EXPIRED meta-issues.
 *
 * ALLOW_UNUSED is deliberately NOT in that list. `validation.allow` is declared
 * once per PACKAGE while validation runs once per SKILL, so "this entry matched
 * nothing" is only answerable across a whole run — see {@link AllowUsageLedger}.
 *
 * Non-registry codes (InfoCode / NonOverridableCode) deliberately bypass
 * severity resolution and pass through unchanged.
 */

import picomatch from 'picomatch';

import { CODE_REGISTRY, type IssueCode, type IssueSeverity } from './validation-codes.js';
import type { AllowEntry, ValidationConfig } from './validation-config.js';
import type { ValidationIssue } from './validation-issue.js';

// The hand-written `ValidationConfig` (from validation-config.ts) is the single
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

/**
 * One `validation.allow` entry's usage during ONE call of the filter.
 *
 * `used` is deliberately not named `unused`: a single call sees a single unit of
 * work (one skill), and `used: false` therefore means "this unit did not match
 * it", NOT "the entry is dead". Only {@link AllowUsageLedger} can answer the
 * latter. The negative name invited exactly that misreading — it was read as a
 * verdict and emitted as ALLOW_UNUSED once per non-matching skill.
 */
export interface AllowEntryUsage {
  code: IssueCode;
  paths: string[];
  reason: string;
  expires?: string | undefined;
  /** True iff at least one issue in THIS call matched the entry. */
  used: boolean;
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
  /** Per-entry usage for THIS call — a contribution to a run, not a verdict. */
  usage: AllowEntryUsage[];
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

function collectExpiredAndUsage(
  matchers: Map<IssueCode, CompiledEntry[]>,
  allowed: AllowRecord[],
  now: Date,
): { expired: ExpiredRecord[]; usage: AllowEntryUsage[] } {
  const expired: ExpiredRecord[] = [];
  const usage: AllowEntryUsage[] = [];

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
      const record: AllowEntryUsage = {
        code,
        paths: m.entry.paths,
        reason: m.entry.reason,
        used: m.used,
      };
      if (m.entry.expires !== undefined) {
        record.expires = m.entry.expires;
      }
      usage.push(record);
    }
  }

  return { expired, usage };
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
    // An allow entry names "a path this finding is about", and a link issue is
    // about TWO: the file that holds the link (`location`) and the target it
    // points at (`link`). Both are legitimate things to suppress, and they want
    // different globs — `LINK_OUTSIDE_PROJECT: ../../docs/**` means "links into
    // the monorepo docs tree are fine anywhere", which is not expressible by
    // naming containing files. Matching either keeps both readings working.
    // (Before the anchor split, `location` WAS the target for walker-derived
    // link issues, so target-keyed allow entries are the ones already in the
    // wild — dropping them would break every adopter config silently.)
    const hit = byCode?.find(m => m.match(location) || (issue.link !== undefined && m.match(issue.link)));
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

  const { expired, usage } = collectExpiredAndUsage(matchers, allowed, now);

  return { emitted, allowed, expired, usage };
}

// ---------------------------------------------------------------------------
// Run-level allow-entry usage
// ---------------------------------------------------------------------------

/**
 * Run-level record of which `validation.allow` entries anything matched.
 *
 * The unit of DECLARATION for an allow entry is the package (`skills.defaults.
 * validation.allow`); the unit of ANALYSIS is one skill. So an entry scoped to
 * two files is not matched by any of the package's other skills — and reporting
 * that per skill produced 78 ALLOW_UNUSED warnings from 3 legitimate entries on
 * this repo's own tree. "Matched nothing" is a property of the RUN.
 *
 * The ledger makes that structural rather than remembered:
 *  - it is monotone — `runValidationFramework` can only ADD to `matched`, so no
 *    single call can conclude an entry is dead, in any call order;
 *  - it is the ONLY producer of ALLOW_UNUSED (see {@link allowUnusedIssues}),
 *    so there is no code path by which per-skill semantics can come back.
 *
 * A caller whose run really is one unit of work uses
 * {@link runSingleUnitValidation}, whose name states that claim.
 */
export interface AllowUsageLedger {
  /**
   * Entry key → the finalized ALLOW_UNUSED issue to emit if the run never
   * matches it. Populated on first sight of an unmatched entry.
   */
  readonly candidates: Map<string, ValidationIssue>;
  /** Keys matched by at least one unit of work anywhere in the run. */
  readonly matched: Set<string>;
}

export function createAllowUsageLedger(): AllowUsageLedger {
  return { candidates: new Map(), matched: new Set() };
}

/**
 * Identity of an allow entry across the calls of one run.
 *
 * Keyed on the declared content rather than on object identity, because a
 * batching caller may re-parse or re-merge config per skill (and `vat audit`
 * spans several governing configs in one run — entries that differ there are
 * different entries, and must be judged separately).
 */
function allowEntryKey(usage: AllowEntryUsage): string {
  return JSON.stringify([usage.code, usage.paths, usage.reason, usage.expires ?? null]);
}

/**
 * ALLOW_UNUSED issues for entries NO unit of work in the run matched.
 *
 * Call once, after the last unit. Severity was already resolved (and `ignore`
 * already applied) when each candidate was recorded, so this needs no config.
 */
export function allowUnusedIssues(ledger: AllowUsageLedger): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [key, issue] of ledger.candidates) {
    if (!ledger.matched.has(key)) issues.push(issue);
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Framework orchestration
// ---------------------------------------------------------------------------

export interface FrameworkResult {
  /**
   * Issues the consumer should surface (severity resolved; ignores dropped).
   *
   * Excludes ALLOW_UNUSED, which is not knowable from one unit of work — drain
   * the run's {@link AllowUsageLedger} with {@link allowUnusedIssues} once the
   * last unit has been validated.
   */
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

/**
 * Build an ALLOW_* meta issue.
 *
 * `field` rather than `location`: `validation.allow.<CODE>` is a pointer INTO
 * the project config, not a file path — and it points into a DIFFERENT file
 * than the skill the allow entry was about. The framework is handed a config
 * object, not the path it was loaded from, so it cannot honestly name the file;
 * emitting the pointer alone is the truthful answer, and it no longer
 * masquerades as something a consumer can resolve as a path.
 */
function metaIssue(code: 'ALLOW_EXPIRED' | 'ALLOW_UNUSED', message: string, field: string): ValidationIssue {
  const entry = CODE_REGISTRY[code];
  return {
    severity: entry.defaultSeverity,
    code,
    message,
    field,
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

/**
 * Fold this call's per-entry usage into the run's ledger.
 *
 * Matched entries record usage; unmatched ones only park a CANDIDATE issue. The
 * two operations are asymmetric on purpose: usage is a run-level union that any
 * later call can still complete, so nothing here can decide an entry is dead.
 */
function recordAllowUsage(
  usage: readonly AllowEntryUsage[],
  config: ValidationConfig,
  ledger: AllowUsageLedger,
): void {
  for (const u of usage) {
    const key = allowEntryKey(u);
    if (u.used) {
      ledger.matched.add(key);
      continue;
    }
    if (ledger.candidates.has(key)) continue;
    const msg = `Allow entry for ${u.code} matched no issues (paths: ${u.paths.join(', ')}).`;
    const final = finalize(metaIssue('ALLOW_UNUSED', msg, `validation.allow.${u.code}`), config);
    if (final) ledger.candidates.set(key, final);
  }
}

/**
 * Run the framework over ONE unit of work (typically one skill).
 *
 * `ledger` is required, not optional-with-a-default, so the compiler asks each
 * caller the question the per-skill call site could not answer on its own:
 * *whose run is this?* Drain it once with {@link allowUnusedIssues} after the
 * last unit; a caller whose run is a single unit should use
 * {@link runSingleUnitValidation} instead.
 */
export function runValidationFramework(
  rawIssues: readonly ValidationIssue[],
  config: ValidationConfig,
  ledger: AllowUsageLedger,
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
  //    Expiry is a property of the entry's own `expires` date, so unlike
  //    unused-ness it IS answerable from one unit of work.
  emitExpiredMeta(filtered.expired, config, emitted);

  // 4. Contribute this unit's allow-entry usage to the run.
  recordAllowUsage(filtered.usage, config, ledger);

  const allowed: AllowRecord[] = filtered.allowed;

  return {
    emitted,
    allowed,
    hasErrors: emitted.some(i => i.severity === 'error'),
  };
}

/**
 * Run the framework where the RUN IS THIS ONE CALL — a whole-registry validate,
 * or a command that validates exactly one skill.
 *
 * The name is the claim: using it inside a loop over skills asserts something
 * false, and is the defect this module's ledger exists to prevent. Multi-unit
 * callers create one {@link AllowUsageLedger} for the run instead.
 */
export function runSingleUnitValidation(
  rawIssues: readonly ValidationIssue[],
  config: ValidationConfig,
  now: Date = new Date(),
): FrameworkResult {
  const ledger = createAllowUsageLedger();
  const result = runValidationFramework(rawIssues, config, ledger, now);
  const emitted = [...result.emitted, ...allowUnusedIssues(ledger)];
  return { ...result, emitted, hasErrors: emitted.some(i => i.severity === 'error') };
}
