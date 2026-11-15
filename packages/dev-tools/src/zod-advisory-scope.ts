#!/usr/bin/env tsx
/**
 * zod-advisory-scope — holds the `osv-scanner.toml` entry for GHSA-mrhx-c7xc-m3w5 to the one zod
 * it was written for.
 *
 * OSV-Scanner cannot scope an `IgnoredVulns` entry to one version, so the entry ignores the advisory
 * for EVERY zod in `bun.lock`; this check enforces the scope, and fails when the entry goes stale.
 * Run: `bun run check:zod-advisory-scope` (full tier). Exit 0 = in scope, 1 = a finding.
 */
import { readFileSync } from 'node:fs';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { compareCodeUnits, safePath } from '@vibe-agent-toolkit/utils';
import semver from 'semver';

import { PROJECT_ROOT, isEntrypoint, log } from './common.js';

const ADVISORY = 'GHSA-mrhx-c7xc-m3w5';
/** The one affected zod the register accepts. */
const ACCEPTED = '3.25.76';
/** The first zod the advisory does not affect (OSV: affected below 4.6.6). */
const FIXED = '4.6.6';

/**
 * A resolution tuple's first element, by its VALUE, under any key: `"knip/zod": ["zod@4.6.7", …]`,
 * and an npm alias `"zod-v3": ["zod@3.22.4", …]` — the package OSV-Scanner reads is the tuple's.
 */
const RESOLVED_ZOD = /": \["zod@([^"]+)"/g;

/** The multi-line string a line ends inside: basic (`"""`, backslash escapes) or literal (`'''`, none). */
type OpenMultiline = '"""' | "'''" | undefined;

/**
 * The index just past the first `delimiter` at or after `from` that closes its string, or -1 when
 * it does not close on this line. A basic string (`"`, `"""`) honours backslash escapes, so `\"""`
 * is content; a literal one (`'`, `'''`) has none. A multi-line string may end with up to two quotes
 * of content before its delimiter (`"""""`), which the close takes with it.
 */
function closingIndex(line: string, from: number, delimiter: string): number {
  const basic = delimiter.startsWith('"');
  let index = from;
  while (index < line.length) {
    if (basic && line[index] === '\\') {
      index += 2;
      continue;
    }
    if (line.startsWith(delimiter, index)) {
      let end = index + delimiter.length;
      while (delimiter.length === 3 && end - index < 5 && line[end] === delimiter[0]) end += 1;
      return end;
    }
    index += 1;
  }
  return -1;
}

/**
 * One step of the scan outside any string, at `index`: where it resumes, and the multi-line string
 * it opened. A comment ends the line; a one-line string is skipped whole, delimiters in it included.
 */
function stepOutsideString(line: string, index: number): { next: number; opened: OpenMultiline } {
  const char = line.charAt(index);
  if (char === '#') return { next: line.length, opened: undefined };
  if (char !== '"' && char !== "'") return { next: index + 1, opened: undefined };
  const triple = char.repeat(3);
  if (line.startsWith(triple, index)) return { next: index + 3, opened: triple as OpenMultiline };
  const close = closingIndex(line, index + 1, char);
  return { next: close === -1 ? line.length : close, opened: undefined };
}

/**
 * The multi-line string `line` leaves open, given the one it opened inside. A string is tracked by
 * the delimiter that opened it — `'''` never closes `"""`, nor the reverse — and a delimiter inside a
 * one-line string or after a comment opens nothing.
 */
function multilineOpenAfter(line: string, open: OpenMultiline): OpenMultiline {
  let state = open;
  let index = 0;
  while (index < line.length) {
    if (state === undefined) {
      ({ next: index, opened: state } = stepOutsideString(line, index));
      continue;
    }
    const close = closingIndex(line, index, state);
    if (close === -1) return state;
    state = undefined;
    index = close;
  }
  return state;
}

/**
 * A line with its comment and surrounding blanks gone. Cut at the first `#`: the header and `id`
 * lines this scan reads carry none inside a value, and a line cut short anywhere else reads as
 * neither.
 */
function significant(line: string): string {
  const hash = line.indexOf('#');
  return (hash === -1 ? line : line.slice(0, hash)).trim();
}

/** A TOML table header: `[name]` or `[[name]]`. */
function isTableHeader(body: string): boolean {
  return body.startsWith('[') && body.endsWith(']');
}

/** The `[[IgnoredVulns]]` array-of-tables header OSV-Scanner reads its ignores from. */
function isIgnoredVulnsHeader(body: string): boolean {
  return body.startsWith('[[') && body.endsWith(']]') && body.slice(2, -2).trim() === 'IgnoredVulns';
}

/** The `id` key naming {@link ADVISORY}, as a basic or a literal string: TOML takes both. */
function isAdvisoryId(body: string): boolean {
  const equals = body.indexOf('=');
  if (equals === -1 || body.slice(0, equals).trim() !== 'id') return false;
  const value = body.slice(equals + 1).trim();
  return value === `"${ADVISORY}"` || value === `'${ADVISORY}'`;
}

/**
 * Whether the register holds an `[[IgnoredVulns]]` entry whose `id` is {@link ADVISORY} — the one
 * shape OSV-Scanner ignores it under. A line scan of the TOML structure that matters: the `id` must
 * sit in an `[[IgnoredVulns]]` table (not another table), outside a multi-line string, uncommented.
 * A line that begins inside a multi-line string is that string's content, whatever it spells.
 */
function registerIgnoresAdvisory(registerText: string): boolean {
  let inIgnoredVulns = false;
  let open: OpenMultiline;
  for (const line of registerText.split(/\r?\n/)) {
    const startedInside = open !== undefined;
    open = multilineOpenAfter(line, open);
    if (startedInside) continue;
    const body = significant(line);
    if (inIgnoredVulns && isAdvisoryId(body)) return true;
    if (isTableHeader(body)) inIgnoredVulns = isIgnoredVulnsHeader(body);
  }
  return false;
}

/** Registry versions in semver order, then any other resolution (git, tarball, workspace) by its text. */
function byVersion(a: string, b: string): number {
  const [validA, validB] = [semver.valid(a) !== null, semver.valid(b) !== null];
  if (validA && validB) return semver.compare(a, b);
  if (validA !== validB) return validA ? -1 : 1;
  return compareCodeUnits(a, b);
}

/** Every distinct zod `bun.lock` resolves — a registry version, or the source text of any other resolution — sorted. */
export function resolvedZodVersions(lockText: string): string[] {
  const versions = new Set<string>();
  for (const match of lockText.matchAll(RESOLVED_ZOD)) {
    if (match[1] !== undefined) versions.add(match[1]);
  }
  return [...versions].toSorted(byVersion);
}

/** Why one resolved zod is outside the register's scope; `undefined` when it is inside. */
function outOfScope(version: string): string | undefined {
  if (version === ACCEPTED) return undefined;
  if (semver.valid(version) === null) {
    return `zod@${version} resolves in bun.lock from a source with no version, so nothing says whether ${ADVISORY} affects it, and the register entry would hide it if it does — resolve it from the registry at >= ${FIXED}`;
  }
  if (semver.gte(version, FIXED)) return undefined;
  return `zod@${version} resolves in bun.lock and is affected by ${ADVISORY}; the register entry covers zod@${ACCEPTED} only — re-resolve it to >= ${FIXED}`;
}

/** Why `osv-scanner.toml`'s entry and `bun.lock` disagree; empty when they agree. */
export function zodAdvisoryScopeFindings(lockText: string, registerText: string): string[] {
  if (!registerIgnoresAdvisory(registerText)) {
    return [`osv-scanner.toml no longer ignores ${ADVISORY}: delete this check (packages/dev-tools/src/zod-advisory-scope.ts) and its gate step`];
  }
  const versions = resolvedZodVersions(lockText);
  if (versions.length === 0) return ['bun.lock resolves no zod: this check cannot have read it — fix the check before trusting it'];
  const findings = versions.map((version) => outOfScope(version)).filter((finding) => finding !== undefined);
  if (!versions.includes(ACCEPTED)) {
    findings.push(`zod@${ACCEPTED} no longer resolves in bun.lock: delete the ${ADVISORY} entry in osv-scanner.toml, then this check`);
  }
  return findings;
}

function main(): void {
  const findings = zodAdvisoryScopeFindings(
    readFileSync(safePath.join(PROJECT_ROOT, 'bun.lock'), 'utf8'),
    readFileSync(safePath.join(PROJECT_ROOT, 'osv-scanner.toml'), 'utf8'),
  );
  if (findings.length > 0) {
    for (const finding of findings) log(`❌ ${finding}`, 'red');
    process.exitCode = ExitCode.FINDINGS;
    return;
  }
  log(`✅ ${ADVISORY}: every resolved zod is ${ACCEPTED} or >= ${FIXED}.`, 'green');
}

if (isEntrypoint(import.meta.url)) main();
