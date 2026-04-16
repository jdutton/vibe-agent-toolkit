import picomatch from 'picomatch';

import type { IssueCode } from './code-registry.js';
import type { ValidationIssue } from './types.js';

export interface AllowEntry {
  paths: string[];
  reason: string;
  expires?: string | undefined;
}

export interface AllowConfig {
  allow?: Partial<Record<IssueCode, AllowEntry[]>>;
}

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
    matchers.set(code, entries.map(e => ({ entry: e, match: picomatch(e.paths), used: false })));
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
