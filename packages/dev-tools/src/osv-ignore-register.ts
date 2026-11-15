#!/usr/bin/env tsx
/**
 * osv-ignore-register — holds every `osv-scanner.toml` ignore to the package versions it was written
 * for, and fails the moment one is no longer needed.
 *
 * OSV-Scanner cannot scope an `[[IgnoredVulns]]` entry to a package or a version (it rejects any key
 * but `id`, `ignoreUntil` and `reason`), so one entry hides its advisory for EVERY package and version
 * in `bun.lock`. {@link ACCEPTED_ADVISORIES} states each entry's scope, and this check holds the
 * register and that table to each other both ways, and the scope to `bun.lock`:
 *   - an entry with no row, or a row with no entry, is red;
 *   - an entry without a `reason` or an `ignoreUntil` (its re-check date) is red;
 *   - an accepted version that no longer resolves is red (the bump that patched it makes the entry,
 *     or that version, stale), and so is a package that no longer resolves at all;
 *   - any other resolved version the advisory affects is red (the entry would hide it).
 * The live half, an advisory whose upstream data no longer matches anything in `bun.lock`, is
 * OSV-Scanner's own "unused ignores" list, which the dependency-audit job fails on.
 * Run: `bun run check:osv-ignores` (full tier). Exit 0 = in scope, 1 = a finding.
 */
import { readFileSync } from 'node:fs';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { compareCodeUnits, safePath } from '@vibe-agent-toolkit/utils';
import semver from 'semver';
import { parse as parseToml } from 'smol-toml';

import { PROJECT_ROOT, isEntrypoint, log } from './common.js';

/** What one register entry accepts: the package the advisory names, and the versions left on it. */
export interface AcceptedAdvisory {
  /** The npm package the advisory is against. */
  readonly package: string;
  /** The exact affected versions the entry is written for; every one must still resolve. */
  readonly accepted: readonly string[];
  /** The advisory's affected range (OSV `affected[].ranges`, as a semver range). */
  readonly affected: string;
}

/** The scope of every `[[IgnoredVulns]]` entry in `osv-scanner.toml`, keyed by advisory id. */
export const ACCEPTED_ADVISORIES: Readonly<Record<string, AcceptedAdvisory>> = {
  // zod 3 has no fixed release; the fix is the zod 4 migration. See the entry's comment.
  'GHSA-mrhx-c7xc-m3w5': { package: 'zod', accepted: ['3.25.76'], affected: '<4.6.6' },
};

/** One `[[IgnoredVulns]]` entry as OSV-Scanner reads it. */
interface IgnoreEntry {
  readonly id: unknown;
  readonly reason?: unknown;
  readonly ignoreUntil?: unknown;
}

/** The register's entries, and a finding for every table OSV-Scanner reads that this check does not scope. */
function readRegister(registerText: string): { entries: IgnoreEntry[]; findings: string[] } {
  const parsed = parseToml(registerText);
  const findings = Object.keys(parsed)
    .filter((key) => key !== 'IgnoredVulns')
    .map((key) => `osv-scanner.toml declares \`${key}\`: the register holds [[IgnoredVulns]] entries only, each scoped in ACCEPTED_ADVISORIES — a [[PackageOverrides]] ignore is wider than one advisory and nothing scopes it`);
  const raw = parsed['IgnoredVulns'];
  const entries = Array.isArray(raw) ? raw.filter((value) => isTable(value)) : [];
  if (Array.isArray(raw) ? entries.length !== raw.length : raw !== undefined) {
    findings.push('osv-scanner.toml `IgnoredVulns` is not an array of tables: write each entry as `[[IgnoredVulns]]`');
  }
  return { entries, findings };
}

/** A TOML table, as `[[IgnoredVulns]]` declares each entry. */
function isTable(value: unknown): value is IgnoreEntry {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** Why one entry's own fields fall short; empty when it carries an id, a reason and a re-check date. */
function entryFieldFindings(entry: IgnoreEntry): string[] {
  const id = typeof entry.id === 'string' ? entry.id : '(no id)';
  const findings: string[] = [];
  if (typeof entry.reason !== 'string' || entry.reason.trim() === '') findings.push(`osv-scanner.toml entry ${id} has no \`reason\`: say why the risk is accepted`);
  if (entry.ignoreUntil === undefined) findings.push(`osv-scanner.toml entry ${id} has no \`ignoreUntil\`: every accepted risk carries the date it is re-checked`);
  return findings;
}

/**
 * A resolution tuple's first element, by its VALUE, under any key: `"knip/zod": ["zod@4.6.7", …]`,
 * an npm alias `"zod-v3": ["zod@3.22.4", …]` — the package OSV-Scanner reads is the tuple's. Group 1
 * is the package name (scope included), group 2 what it resolves to.
 */
const RESOLUTION = /": \["(@?[^"@]+)@([^"]+)"/g;

/** Registry versions in semver order, then any other resolution (git, tarball, workspace) by its text. */
function byVersion(a: string, b: string): number {
  const [validA, validB] = [semver.valid(a) !== null, semver.valid(b) !== null];
  if (validA && validB) return semver.compare(a, b);
  if (validA !== validB) return validA ? -1 : 1;
  return compareCodeUnits(a, b);
}

/**
 * Every distinct version of `packageName` that `bun.lock` resolves, sorted, read by {@link RESOLUTION}.
 */
export function resolvedVersions(lockText: string, packageName: string): string[] {
  const versions = new Set<string>();
  for (const [, name, version] of lockText.matchAll(RESOLUTION)) {
    if (name === packageName && version !== undefined) versions.add(version);
  }
  return [...versions].toSorted(byVersion);
}

/** Why one resolved version is outside an entry's scope; `undefined` when it is inside. */
function outOfScope(id: string, scope: AcceptedAdvisory, version: string): string | undefined {
  if (scope.accepted.includes(version)) return undefined;
  const name = `${scope.package}@${version}`;
  if (semver.valid(version) === null) {
    return `${name} resolves in bun.lock from a source with no version, so nothing says whether ${id} affects it, and the register entry would hide it if it does — resolve it from the registry`;
  }
  if (!semver.satisfies(version, scope.affected, { includePrerelease: true })) return undefined;
  return `${name} resolves in bun.lock and is affected by ${id} (${scope.affected}); the register entry accepts ${scope.accepted.join(', ')} only — re-resolve it to a fixed version`;
}

/** Why one scoped entry and `bun.lock` disagree. */
function scopeFindings(id: string, scope: AcceptedAdvisory, lockText: string): string[] {
  const versions = resolvedVersions(lockText, scope.package);
  if (versions.length === 0) {
    return [`${scope.package} no longer resolves in bun.lock: delete the ${id} entry in osv-scanner.toml and its ACCEPTED_ADVISORIES row`];
  }
  const findings = versions.map((version) => outOfScope(id, scope, version)).filter((finding) => finding !== undefined);
  for (const version of scope.accepted) {
    if (!versions.includes(version)) {
      findings.push(`${scope.package}@${version} no longer resolves in bun.lock: drop it from ${id}'s ACCEPTED_ADVISORIES row, and delete the entry in osv-scanner.toml if nothing it accepts is left`);
    }
  }
  return findings;
}

/** Why `osv-scanner.toml`, {@link ACCEPTED_ADVISORIES} and `bun.lock` disagree; empty when they agree. */
export function osvIgnoreFindings(
  lockText: string,
  registerText: string,
  accepted: Readonly<Record<string, AcceptedAdvisory>>,
): string[] {
  const { entries, findings } = readRegister(registerText);
  const ids = new Set<string>();
  for (const entry of entries) {
    findings.push(...entryFieldFindings(entry));
    if (typeof entry.id !== 'string') continue;
    ids.add(entry.id);
    const scope = accepted[entry.id];
    if (scope === undefined) {
      findings.push(`osv-scanner.toml ignores ${entry.id}, which has no ACCEPTED_ADVISORIES row (packages/dev-tools/src/osv-ignore-register.ts): scope it to the package versions it accepts, or fix the advisory and delete the entry`);
      continue;
    }
    findings.push(...scopeFindings(entry.id, scope, lockText));
  }
  for (const id of Object.keys(accepted)) {
    if (!ids.has(id)) findings.push(`ACCEPTED_ADVISORIES scopes ${id}, which osv-scanner.toml no longer ignores: delete the row`);
  }
  return findings;
}

function main(): void {
  const findings = osvIgnoreFindings(
    readFileSync(safePath.join(PROJECT_ROOT, 'bun.lock'), 'utf8'),
    readFileSync(safePath.join(PROJECT_ROOT, 'osv-scanner.toml'), 'utf8'),
    ACCEPTED_ADVISORIES,
  );
  if (findings.length > 0) {
    for (const finding of findings) log(`❌ ${finding}`, 'red');
    process.exitCode = ExitCode.FINDINGS;
    return;
  }
  const count = Object.keys(ACCEPTED_ADVISORIES).length;
  log(`✅ osv-scanner.toml: ${count} ignore(s), each scoped to the versions it accepts, each still needed.`, 'green');
}

if (isEntrypoint(import.meta.url)) main();
