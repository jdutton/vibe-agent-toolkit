#!/usr/bin/env tsx
/**
 * osv-ignore-scan — the live half of holding every `osv-scanner.toml` ignore to the package versions
 * it was written for, judged against what OSV itself reports.
 *
 * The dependency-audit job scans `bun.lock` with an EMPTY config (`--format json`), so nothing is
 * filtered, and hands the report here. Every reported advisory must be ignored by an entry whose
 * ACCEPTED_ADVISORIES row names that exact package and version; every entry must still match a
 * reported advisory. So the scope comes from OSV's own data, not from a copy of it:
 *   - an advisory no entry ignores is red (un-triaged: fix it, or add an entry and a row);
 *   - an ignored advisory against a package or version its row does not accept is red (the entry
 *     would hide it — OSV amended a range, or the advisory names another package);
 *   - an entry no reported advisory matches is red (unused: delete it and its row);
 *   - an entry past its `ignoreUntil` is red (re-check its reason);
 *   - plus every register and pairing finding the offline half (`osv-ignore-register.ts`) reports.
 * Run: `bun run check:osv-scan <report.json>` (dependency-audit job). Exit 0 = clean, 1 = a finding,
 * 2 = it could not do its job: no report path, or a file that is missing, not JSON, or not in the
 * osv-scanner `--format json` shape (`readScanReport`).
 */
import { readFileSync } from 'node:fs';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { safePath, appendAll } from '@vibe-agent-toolkit/utils';
import { z } from 'zod';

import { PROJECT_ROOT, isEntrypoint, log } from './common.js';
import {
  ACCEPTED_ADVISORIES,
  type AcceptedAdvisory,
  type IgnoreEntry,
  pairingFindings,
  readRegister,
  reportFindings,
} from './osv-ignore-register.js';

/** The part of an osv-scanner `--format json` report this check reads. */
const ScanReportSchema = z
  .object({
    results: z.array(
      z
        .object({
          packages: z.array(
            z
              .object({
                package: z.object({ name: z.string(), version: z.string(), ecosystem: z.string() }).strip(),
                vulnerabilities: z.array(z.object({ id: z.string(), aliases: z.array(z.string()).default([]) }).strip()),
              })
              .strip(),
          ),
        })
        .strip(),
    ),
  })
  .strip();

/** An osv-scanner `--format json` report, as far as this check reads it. */
export type ScanReport = z.infer<typeof ScanReportSchema>;

/** A report read from its text, or why it could not be: the check cannot judge a report it cannot read. */
export type ScanRead = { readonly ok: true; readonly report: ScanReport } | { readonly ok: false; readonly error: string };

/** Parses an osv-scanner `--format json` report. */
export function readScanReport(text: string): ScanRead {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `the scan report is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = ScanReportSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: `the scan report is not an osv-scanner --format json report: ${parsed.error.issues[0]?.message ?? 'unreadable'}` };
  return { ok: true, report: parsed.data };
}

/** One advisory reported against one resolved package: every id OSV knows it by. */
interface Hit {
  readonly name: string;
  readonly version: string;
  readonly ecosystem: string;
  readonly ids: readonly string[];
}

function hitsOf(report: ScanReport): Hit[] {
  return report.results.flatMap((result) =>
    result.packages.flatMap(({ package: pkg, vulnerabilities }) =>
      vulnerabilities.map((vuln) => ({ name: pkg.name, version: pkg.version, ecosystem: pkg.ecosystem, ids: [vuln.id, ...vuln.aliases] })),
    ),
  );
}

/** Why one hit is not covered by the entry that ignores it; `undefined` when it is. */
function hitFinding(hit: Hit, entryIds: ReadonlySet<string>, accepted: Readonly<Record<string, AcceptedAdvisory>>): string | undefined {
  const label = `${hit.name}@${hit.version} (${hit.ecosystem})`;
  const id = hit.ids.find((candidate) => entryIds.has(candidate));
  if (id === undefined) return `${hit.ids.join(' / ')} affects ${label} and no osv-scanner.toml entry ignores it: fix it under rule 1, or add an entry and its ACCEPTED_ADVISORIES row`;
  const scope = accepted[id];
  if (scope === undefined) return undefined; // the pairing finding names it
  if (hit.ecosystem === 'npm' && hit.name === scope.package && scope.accepted.includes(hit.version)) return undefined;
  return `${id} affects ${label}, which its ACCEPTED_ADVISORIES row does not accept (${scope.package}@${scope.accepted.join(', ')}): the ignore would hide it — fix it, or widen the row on purpose`;
}

/** Why one entry is past its re-check date; empty while it is in date. */
function expiryFindings(entry: IgnoreEntry, now: Date): string[] {
  if (entry.ignoreUntil.getTime() > now.getTime()) return [];
  return [`osv-scanner.toml entry ${entry.id} expired on ${entry.ignoreUntil.toISOString()}: re-check its reason, then fix the advisory or move the date`];
}

/** Why an empty-config osv-scanner report and the register disagree; empty when they agree. */
export function osvScanFindings(report: ScanReport, registerText: string, accepted: Readonly<Record<string, AcceptedAdvisory>>, now: Date): string[] {
  const { ids, entries, findings } = readRegister(registerText);
  const all = [...findings, ...pairingFindings(ids, accepted)];
  const matched = new Set<string>();
  for (const hit of hitsOf(report)) {
    for (const id of hit.ids) if (ids.has(id)) matched.add(id);
    const finding = hitFinding(hit, ids, accepted);
    if (finding !== undefined) all.push(finding);
  }
  for (const id of ids) {
    if (!matched.has(id)) all.push(`osv-scanner.toml ignores ${id}, which the scan no longer reports against bun.lock: delete the entry and its ACCEPTED_ADVISORIES row`);
  }
  for (const entry of entries) appendAll(all, expiryFindings(entry, now));
  return all;
}

function main(): void {
  const [reportPath] = process.argv.slice(2);
  if (reportPath === undefined) {
    log('usage: check:osv-scan <osv-scanner --format json report>', 'red');
    process.exitCode = ExitCode.ERROR;
    return;
  }
  let text: string;
  try {
    text = readFileSync(safePath.resolve(reportPath), 'utf8');
  } catch (error) {
    log(`cannot read the scan report ${reportPath}: ${error instanceof Error ? error.message : String(error)}`, 'red');
    process.exitCode = ExitCode.ERROR;
    return;
  }
  const read = readScanReport(text);
  if (!read.ok) {
    log(read.error, 'red');
    process.exitCode = ExitCode.ERROR;
    return;
  }
  const findings = osvScanFindings(read.report, readFileSync(safePath.join(PROJECT_ROOT, 'osv-scanner.toml'), 'utf8'), ACCEPTED_ADVISORIES, new Date());
  reportFindings(findings, 'every advisory OSV reports against bun.lock is ignored within its accepted versions, and every ignore is in use and in date.');
}

if (isEntrypoint(import.meta.url)) main();
