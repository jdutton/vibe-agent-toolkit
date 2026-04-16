import picomatch from 'picomatch';

import type { IssueCode } from './code-registry.js';
import type { ValidationIssue } from './types.js';

export interface AcceptEntry {
  paths: string[];
  reason: string;
  expires?: string | undefined;
}

export interface AcceptConfig {
  accept?: Partial<Record<IssueCode, AcceptEntry[]>>;
}

export interface AcceptRecord {
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

export interface AcceptFilterResult {
  emitted: ValidationIssue[];
  accepted: AcceptRecord[];
  expired: ExpiredRecord[];
  unused: UnusedRecord[];
}

interface CompiledEntry {
  entry: AcceptEntry;
  match: (p: string) => boolean;
  used: boolean;
}

function isExpired(expires: string | undefined, now: Date): boolean {
  if (!expires) return false;
  const parsed = Date.parse(expires);
  return Number.isFinite(parsed) && parsed < now.getTime();
}

function buildMatchers(
  acceptByCode: Partial<Record<IssueCode, AcceptEntry[]>>,
): Map<IssueCode, CompiledEntry[]> {
  const matchers = new Map<IssueCode, CompiledEntry[]>();
  for (const [code, entries] of Object.entries(acceptByCode) as Array<[IssueCode, AcceptEntry[] | undefined]>) {
    if (!entries) continue;
    matchers.set(code, entries.map(e => ({ entry: e, match: picomatch(e.paths), used: false })));
  }
  return matchers;
}

function collectExpiredAndUnused(
  matchers: Map<IssueCode, CompiledEntry[]>,
  accepted: AcceptRecord[],
  now: Date,
): { expired: ExpiredRecord[]; unused: UnusedRecord[] } {
  const expired: ExpiredRecord[] = [];
  const unused: UnusedRecord[] = [];

  for (const [code, list] of matchers) {
    for (const m of list) {
      if (isExpired(m.entry.expires, now)) {
        const matchedLocations = accepted
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

export function applyAcceptFilter(
  issues: readonly ValidationIssue[],
  config: AcceptConfig,
  now: Date = new Date(),
): AcceptFilterResult {
  const emitted: ValidationIssue[] = [];
  const accepted: AcceptRecord[] = [];

  const matchers = buildMatchers(config.accept ?? {});

  for (const issue of issues) {
    const code = issue.code as IssueCode;
    const byCode = matchers.get(code);
    const location = issue.location ?? '';
    const hit = byCode?.find(m => m.match(location));
    if (hit) {
      hit.used = true;
      const record: AcceptRecord = {
        code,
        location,
        reason: hit.entry.reason,
      };
      if (hit.entry.expires !== undefined) {
        record.expires = hit.entry.expires;
      }
      accepted.push(record);
    } else {
      emitted.push(issue);
    }
  }

  const { expired, unused } = collectExpiredAndUnused(matchers, accepted, now);

  return { emitted, accepted, expired, unused };
}
