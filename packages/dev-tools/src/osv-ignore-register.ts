#!/usr/bin/env tsx
/**
 * osv-ignore-register — the offline half of holding every `osv-scanner.toml` ignore to the package
 * versions it was written for.
 *
 * OSV-Scanner cannot scope an `[[IgnoredVulns]]` entry to a package or a version (it rejects any key
 * but `id`, `ignoreUntil` and `reason`), so one entry hides its advisory for EVERY package and version
 * OSV lists under that id. {@link ACCEPTED_ADVISORIES} names, per entry, the package and the exact
 * versions it accepts. This check holds the register, that table and `bun.lock` together:
 *   - an entry with no row, or a row with no entry, is red;
 *   - an entry without a string `id`, a `reason` or an `ignoreUntil` TOML date is red;
 *   - any top-level table other than `IgnoredVulns` is red;
 *   - an accepted version that no longer resolves in `bun.lock` is red (the bump that patched it
 *     makes the entry, or that version, stale), and so is a package that no longer resolves at all.
 * What OSV says the advisory affects is the other half, `osv-ignore-scan.ts`, run by the
 * dependency-audit job against a live empty-config scan.
 * Run: `bun run check:osv-ignores` (full tier). Exit 0 = in scope, 1 = a finding.
 */
import { readFileSync } from 'node:fs';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { compareCodeUnits, safePath } from '@vibe-agent-toolkit/utils';
import { parse as parseToml, TomlDate } from 'smol-toml';

import { PROJECT_ROOT, isEntrypoint, log } from './common.js';

/** What one register entry accepts: the package the advisory names, and the versions left on it. */
export interface AcceptedAdvisory {
  /** The npm package the advisory is against. */
  readonly package: string;
  /** The exact affected versions the entry is written for; every one must still resolve. */
  readonly accepted: readonly string[];
}

/** The scope of every `[[IgnoredVulns]]` entry in `osv-scanner.toml`, keyed by advisory id. */
export const ACCEPTED_ADVISORIES: Readonly<Record<string, AcceptedAdvisory>> = {
  // zod 3 has no fixed release; the fix is the zod 4 migration. See the entry's comment.
  'GHSA-mrhx-c7xc-m3w5': { package: 'zod', accepted: ['3.25.76'] },
  // No picomatch release is fixed (the advisory runs through the latest). See the entry's comment.
  'GHSA-fc5q-39xc-vjpf': { package: 'picomatch', accepted: ['2.3.2', '4.0.5'] },
};

/** One well-formed `[[IgnoredVulns]]` entry. */
export interface IgnoreEntry {
  readonly id: string;
  readonly ignoreUntil: TomlDate;
}

/** The register: every id it ignores, its well-formed entries, and why any part of it is not. */
export interface Register {
  /** Every string `id`, well-formed entry or not: OSV-Scanner ignores by `id` alone. */
  readonly ids: ReadonlySet<string>;
  readonly entries: readonly IgnoreEntry[];
  readonly findings: readonly string[];
}

/** A TOML table, as `[[IgnoredVulns]]` declares each entry. */
function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** The entry, or why its own fields fall short of an id, a reason and a re-check date. */
function readEntry(table: Record<string, unknown>, index: number): { entry: IgnoreEntry | undefined; findings: string[] } {
  const { id, reason, ignoreUntil } = table;
  const name = typeof id === 'string' && id.trim() !== '' ? id : `#${index + 1}`;
  const findings: string[] = [];
  if (name !== id) findings.push(`osv-scanner.toml entry ${name} has no string \`id\`: name the advisory it ignores`);
  if (typeof reason !== 'string' || reason.trim() === '') findings.push(`osv-scanner.toml entry ${name} has no \`reason\`: say why the risk is accepted`);
  if (!(ignoreUntil instanceof TomlDate) || ignoreUntil.isTime()) {
    findings.push(`osv-scanner.toml entry ${name} has no \`ignoreUntil\` date: every accepted risk carries the date it is re-checked, as a TOML date (ignoreUntil = 2026-12-31)`);
  }
  if (findings.length > 0 || typeof id !== 'string' || !(ignoreUntil instanceof TomlDate)) return { entry: undefined, findings };
  return { entry: { id, ignoreUntil }, findings };
}

/** Parse `osv-scanner.toml` into its entries and every finding about its shape. */
export function readRegister(registerText: string): Register {
  const parsed = parseToml(registerText);
  const findings = Object.keys(parsed)
    .filter((key) => key !== 'IgnoredVulns')
    .map((key) => `osv-scanner.toml declares \`${key}\`, which this register does not allow: it holds [[IgnoredVulns]] entries only, each scoped in ACCEPTED_ADVISORIES`);
  const raw = parsed['IgnoredVulns'];
  const ids = new Set<string>();
  if (raw === undefined) return { ids, entries: [], findings };
  if (!Array.isArray(raw) || !raw.every((value) => isTable(value))) {
    return { ids, entries: [], findings: [...findings, 'osv-scanner.toml `IgnoredVulns` is not an array of tables: write each entry as `[[IgnoredVulns]]`'] };
  }
  const entries: IgnoreEntry[] = [];
  for (const [index, table] of raw.entries()) {
    const id = table['id'];
    if (typeof id === 'string' && id.trim() !== '') ids.add(id);
    const read = readEntry(table, index);
    findings.push(...read.findings);
    if (read.entry !== undefined) entries.push(read.entry);
  }
  return { ids, entries, findings };
}

/** Every entry paired with its row, and a finding for each side left without a partner. */
export function pairingFindings(ids: ReadonlySet<string>, accepted: Readonly<Record<string, AcceptedAdvisory>>): string[] {
  const findings = [...ids]
    .filter((id) => accepted[id] === undefined)
    .map((id) => `osv-scanner.toml ignores ${id}, which has no ACCEPTED_ADVISORIES row (packages/dev-tools/src/osv-ignore-register.ts): scope it to the package versions it accepts, or fix the advisory and delete the entry`);
  for (const id of Object.keys(accepted)) {
    if (!ids.has(id)) findings.push(`ACCEPTED_ADVISORIES scopes ${id}, which osv-scanner.toml does not ignore: delete the row`);
  }
  return findings;
}

/**
 * A resolution tuple's first element, by its VALUE, under any key: `"knip/zod": ["zod@4.6.7", …]`,
 * an npm alias `"zod-v3": ["zod@3.22.4", …]` — the package OSV-Scanner reads is the tuple's. Group 1
 * is the package name (scope included), group 2 what it resolves to.
 */
const RESOLUTION = /": \["(@?[^"@]+)@([^"]+)"/g;

/** Every distinct version of `packageName` that `bun.lock` resolves, sorted, read by {@link RESOLUTION}. */
export function resolvedVersions(lockText: string, packageName: string): string[] {
  const versions = new Set<string>();
  for (const [, name, version] of lockText.matchAll(RESOLUTION)) {
    if (name === packageName && version !== undefined) versions.add(version);
  }
  return [...versions].toSorted(compareCodeUnits);
}

/** Why one scoped entry's accepted versions no longer match `bun.lock`. */
function lockFindings(id: string, scope: AcceptedAdvisory, lockText: string): string[] {
  const versions = resolvedVersions(lockText, scope.package);
  if (versions.length === 0) {
    return [`${scope.package} no longer resolves in bun.lock: delete the ${id} entry in osv-scanner.toml and its ACCEPTED_ADVISORIES row`];
  }
  return scope.accepted
    .filter((version) => !versions.includes(version))
    .map((version) => `${scope.package}@${version} no longer resolves in bun.lock: drop it from ${id}'s ACCEPTED_ADVISORIES row, and delete the entry in osv-scanner.toml if nothing it accepts is left`);
}

/** Why `osv-scanner.toml`, {@link ACCEPTED_ADVISORIES} and `bun.lock` disagree; empty when they agree. */
export function osvIgnoreFindings(lockText: string, registerText: string, accepted: Readonly<Record<string, AcceptedAdvisory>>): string[] {
  const { ids, findings } = readRegister(registerText);
  const all = [...findings, ...pairingFindings(ids, accepted)];
  for (const id of ids) {
    const scope = accepted[id];
    if (scope !== undefined) all.push(...lockFindings(id, scope, lockText));
  }
  return all;
}

/** Log each finding and set the exit code; `success` is the line printed when there are none. */
export function reportFindings(findings: readonly string[], success: string): void {
  if (findings.length > 0) {
    for (const finding of findings) log(`❌ ${finding}`, 'red');
    process.exitCode = ExitCode.FINDINGS;
    return;
  }
  log(`✅ ${success}`, 'green');
}

function main(): void {
  const findings = osvIgnoreFindings(
    readFileSync(safePath.join(PROJECT_ROOT, 'bun.lock'), 'utf8'),
    readFileSync(safePath.join(PROJECT_ROOT, 'osv-scanner.toml'), 'utf8'),
    ACCEPTED_ADVISORIES,
  );
  const count = Object.keys(ACCEPTED_ADVISORIES).length;
  reportFindings(findings, `osv-scanner.toml: ${count} ignore(s), each paired with its scope row, each accepted version still in bun.lock.`);
}

if (isEntrypoint(import.meta.url)) main();
