/**
 * Turn `vat audit` — which is advisory and always exits 0 — into a hard gate
 * over THIS repository.
 *
 * 🔑 **Why this lives here and not behind a `vat audit --strict` flag.** The
 * moment `audit` can fail, it needs waivers, and a waiver system keyed to
 * findings is `resources.validation.severity` / `.allow` — i.e. `vat validate`,
 * which already exists. Growing a second, worse validation surface on a command
 * whose published contract is "advisory, exit 0" would be the wrong product
 * move. Adopters gate with `vibe-agent-toolkit.config.yaml`; `vat audit` is a
 * report you read. **We** are the exception, because we dogfood: this step
 * fails on unexpected quality in our own tree, and on `vat audit` itself
 * producing something we cannot read.
 *
 * ⛔ **This is not a baseline and must never become one.** There is no count to
 * bump. Every exemption is a PATH CLASS or a specific code with a written
 * reason, and an exemption that stops matching anything FAILS THE GATE rather
 * than lingering — see {@link findStaleExemptions}. A register whose entries
 * cannot expire rots into a list nobody reads.
 *
 * Run: `bun run guard:audit-quality`.
 */

import { toForwardSlash } from '@vibe-agent-toolkit/utils';
import { parse } from 'yaml';

import { PROJECT_ROOT, isEntrypoint, log, safeExecResult } from './common.js';

/**
 * Severities this gate lets through, as an allowlist of the ADVISORY ones.
 * `info` is advice and `ignore` is a severity the author deliberately silenced;
 * a warning is a failure with a softer name.
 *
 * 🔑 **Inverted deliberately.** Listing the FAILING severities instead reads more
 * naturally and is wrong in the one direction that matters: a severity this gate
 * does not recognise — `warning` renamed upstream, or the `<unknown>` that
 * {@link parseAuditFindings} substitutes when the field goes missing — would
 * fall outside the list and silently stop failing. That is precisely "a report
 * we cannot read is indistinguishable from a clean repository", the defect this
 * file's header calls out. With the allowlist on this side, an unreadable or
 * unfamiliar severity fails, and the fix is to add it here on purpose.
 */
const ADVISORY_SEVERITIES = new Set(['info', 'ignore']);

/** One finding, reduced to the fields a gate decision can rest on. */
export interface AuditFinding {
  readonly file: string;
  readonly code: string;
  readonly severity: string;
  readonly message: string;
}

/**
 * A declared reason a finding is not a defect.
 *
 * `kind` separates two things that must not be confused when reading a report:
 * `structural` is permanent by nature (a fixture is deliberately malformed; a
 * vendored file is not ours to edit), while `debt` is a real defect we have
 * chosen not to fix yet and want printed loudly on every run.
 */
export interface Exemption {
  readonly kind: 'structural' | 'debt';
  /** Path prefix the finding's file must start with. */
  readonly pathPrefix: string;
  /** Codes this covers. Empty means every code under that prefix. */
  readonly codes: readonly string[];
  /** Why this is not a defect. Written for the person deciding whether it still holds. */
  readonly reason: string;
}

export const EXEMPTIONS: readonly Exemption[] = [
  {
    kind: 'structural',
    pathPrefix: 'docs/research/fixtures/',
    codes: [],
    reason:
      'Research fixtures for the plugin-loader semantics study. Their malformed shapes ARE the '
      + 'experiment — a fixture that passes audit tests nothing.',
  },
  {
    kind: 'structural',
    pathPrefix: 'packages/agent-skills/vendor/',
    codes: [],
    reason:
      'Vendored third-party skills. Editing them to satisfy our own linter would fork them from '
      + 'upstream, which is the one thing a vendor directory exists to avoid.',
  },
  {
    kind: 'structural',
    pathPrefix: 'packages/vat-development-agents/plugins/',
    codes: ['PLUGIN_MISSING_VERSION'],
    reason:
      'SOURCE-PHASE FALSE POSITIVE. The source plugin.json is deliberately minimal (name + '
      + 'license); `vat build` injects version, author and description, and the built artifact '
      + 'carries them. A check that runs at the source phase over a field the build supplies '
      + 'cannot be satisfied at the source phase. ⚠️ If the build stops injecting `version`, this '
      + 'exemption hides a real defect — verify the built plugin.json before trusting it.',
  },
];

/** A finding with no exemption covering it — the reason this gate exists. */
export interface GateResult {
  readonly unexpected: readonly AuditFinding[];
  readonly excused: readonly { readonly finding: AuditFinding; readonly exemption: Exemption }[];
  readonly staleExemptions: readonly Exemption[];
}

function covers(exemption: Exemption, finding: AuditFinding): boolean {
  // `vat audit` reports host-shaped paths, so on Windows a `/`-spelled prefix
  // would match nothing and every declared exemption would quietly stop working.
  if (!toForwardSlash(finding.file).startsWith(toForwardSlash(exemption.pathPrefix))) return false;
  return exemption.codes.length === 0 || exemption.codes.includes(finding.code);
}

/**
 * An exemption matching nothing is the register's rot signal.
 *
 * 🚨 It fails the gate rather than warning, and the direction is deliberate: a
 * stale entry always errs toward EXCUSING something nobody has looked at since
 * the reason was written. Deleting the entry is a one-line change; discovering
 * years later that it was hiding a real finding is not.
 */
export function findStaleExemptions(
  exemptions: readonly Exemption[],
  findings: readonly AuditFinding[],
): Exemption[] {
  return exemptions.filter((e) => !findings.some((f) => covers(e, f)));
}

/** Classify every failing-severity finding. Pure: the whole gate decision, no I/O. */
export function classifyFindings(
  findings: readonly AuditFinding[],
  exemptions: readonly Exemption[] = EXEMPTIONS,
): GateResult {
  const failing = findings.filter((f) => !ADVISORY_SEVERITIES.has(f.severity));
  const unexpected: AuditFinding[] = [];
  const excused: { finding: AuditFinding; exemption: Exemption }[] = [];
  for (const finding of failing) {
    const exemption = exemptions.find((e) => covers(e, finding));
    if (exemption) excused.push({ finding, exemption });
    else unexpected.push(finding);
  }
  return { unexpected, excused, staleExemptions: findStaleExemptions(exemptions, failing) };
}

/** One issue, as far as this gate insists on reading it. */
interface RawIssue {
  severity?: unknown;
  code?: unknown;
  message?: unknown;
}

/** One file entry. `issues` is REQUIRED — see {@link assertAuditReportShape}. */
interface RawFileEntry {
  path?: unknown;
  issues: RawIssue[];
}

/** The slice of `vat audit`'s document this gate reads. Anything else is ignored. */
interface AuditReportShape {
  status?: unknown;
  files: RawFileEntry[];
}

/**
 * Validate ONE `files[]` entry, at the SAME strictness as `files` itself.
 *
 * 🚨 **This level used to be coerced** — `Array.isArray(file.issues) ? … : []` —
 * and that single ternary was enough to hand the gate a permanent, silent
 * bypass. Group the findings by severity upstream (a plausible, entirely
 * reasonable shape change) and every real `severity: error` finding parses to
 * nothing: `findings parsed: 0`, `unexpected: 0`. The gate still fails, but for
 * the only reason left — `N exemption(s) match nothing — delete them` — and a
 * maintainer who FOLLOWS THAT PRINTED INSTRUCTION deletes the exemptions and
 * turns the gate green forever over a report it can no longer read. The
 * anti-rot mechanism becomes the delivery vehicle. Two levels validated and the
 * third coerced is not "mostly strict"; the coerced level is the whole hole.
 *
 * A file with nothing wrong emits `issues: []`, so requiring the key costs
 * nothing against the shipped emitter and refuses every shape that is not it.
 */
function assertFileEntry(entry: unknown): RawFileEntry {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new TypeError(
      `vat audit report carries a file entry that is not a mapping (${typeof entry}) `
      + '— its output shape changed.',
    );
  }
  const file = entry as { path?: unknown; issues?: unknown };
  if (!Array.isArray(file.issues)) {
    throw new TypeError(
      `vat audit report carries no \`issues\` array for ${text(file.path, '<unknown>')} `
      + '— its output shape changed.',
    );
  }
  return { path: file.path, issues: file.issues as RawIssue[] };
}

/**
 * Read the findings out of `vat audit`'s YAML.
 *
 * 🔑 **This half dogfoods `vat audit` itself**, which is why it throws a NAMED
 * error instead of coercing. A report we cannot read is indistinguishable, to a
 * `filter(...).length === 0` gate, from a clean repository — so a shape change
 * in the command we ship would silently switch our own quality gate off. That
 * is the failure this repo keeps meeting under other names.
 */
function assertAuditReportShape(doc: unknown): AuditReportShape {
  if (typeof doc !== 'object' || doc === null) {
    throw new TypeError('vat audit produced no YAML document — cannot judge the repository.');
  }
  const report = doc as { status?: unknown; files?: unknown };
  if (report.status === undefined) {
    throw new TypeError('vat audit report carries no `status` — its output shape changed.');
  }
  if (!Array.isArray(report.files)) {
    throw new TypeError('vat audit report carries no `files` array — its output shape changed.');
  }
  return { status: report.status, files: report.files.map((entry) => assertFileEntry(entry)) };
}

/** A missing field becomes `<unknown>` rather than dropping the finding: an
 * unreadable finding must still reach the gate as something that fails. */
const text = (value: unknown, fallback: string): string =>
  (typeof value === 'string' ? value : fallback);

export function parseAuditFindings(stdout: string): AuditFinding[] {
  const report = assertAuditReportShape(parse(stdout));
  const findings: AuditFinding[] = [];
  for (const file of report.files) {
    const path = text(file.path, '<unknown>');
    for (const issue of file.issues) {
      findings.push({
        file: path,
        code: text(issue.code, '<unknown>'),
        severity: text(issue.severity, '<unknown>'),
        message: text(issue.message, ''),
      });
    }
  }
  return findings;
}

function reportDebt(result: GateResult): void {
  const debt = result.excused.filter((e) => e.exemption.kind === 'debt');
  if (debt.length === 0) return;
  log(`\n⚠️  ${debt.length} known-debt finding(s) excused — these are real and unfixed:`, 'yellow');
  for (const { finding } of debt) log(`   ${finding.file}: ${finding.code}`, 'yellow');
}

function reportFailures(result: GateResult): void {
  if (result.unexpected.length > 0) {
    log(`\n❌ ${result.unexpected.length} unexpected audit finding(s):`, 'red');
    for (const f of result.unexpected) {
      log(`   ${f.file}\n     ${f.severity} ${f.code}: ${f.message}`, 'red');
    }
    log('\nFix them, or add an exemption to EXEMPTIONS with a written reason.', 'red');
  }
  if (result.staleExemptions.length > 0) {
    log(`\n❌ ${result.staleExemptions.length} exemption(s) match nothing — delete them:`, 'red');
    for (const e of result.staleExemptions) log(`   ${e.pathPrefix} ${e.codes.join(',') || '*'}`, 'red');
  }
}

/** The three things about the invocation itself that must hold before its output can be read. */
export interface AuditRun {
  /** `spawnSync`'s own error: command missing, ENOBUFS on a maxBuffer overrun, signal kill. */
  readonly error?: Error | undefined;
  readonly status: number;
  readonly stdout: string;
}

/**
 * Why this `vat audit` run cannot be believed, or `null` if it can.
 *
 * 🚨 **Every branch here fails CLOSED, and each was a live hole.** `main()` used
 * to read `stdout` and nothing else, so:
 *
 * - **`error`** — `spawnSync` reports a `maxBuffer` overrun as ENOBUFS while
 *   still handing back the bytes it did collect. A truncated report parses, into
 *   FEWER findings, so a clipped or OOM-killed run read as a CLEANER repository.
 *   The `maxBuffer` bump below buys headroom; only this check makes the overrun
 *   itself audible. The heap guard fixed in this same release already does this
 *   — the audit gate had copied its `maxBuffer` half and not its check.
 * - **`status`** — `vat audit` exits 0 BY DESIGN, and that is a published
 *   contract: `status` describes the FINDINGS, the exit code describes whether
 *   the RUN completed. Which makes a non-zero code unambiguous — the command
 *   crashed — and whatever it printed before dying is a partial report, not a
 *   verdict. No specific crash is named here on purpose: the one this check was
 *   written against was already fixed before it shipped, and a docstring that
 *   cites a repaired bug as live evidence rots into a false claim. The reason to
 *   fail closed is the CLASS, which no fix retires.
 * - **empty stdout** — the document is the signal; no document means the command
 *   did not run.
 */
export function auditRunFailure(run: AuditRun): string | null {
  if (run.error) return `vat audit could not be run to completion: ${run.error.message}`;
  if (run.status !== 0) {
    return `vat audit exited ${run.status.toString()} — it exits 0 by design, so it crashed. `
      + 'Its output is a partial report, not a verdict.';
  }
  if (!run.stdout.trim()) return 'vat audit produced no output — the command did not run.';
  return null;
}

function main(): void {
  const result = safeExecResult('bun', ['run', 'vat', 'audit'], {
    cwd: PROJECT_ROOT,
    // `spawnSync`'s default maxBuffer is 1 MiB and it TRUNCATES rather than
    // failing. A truncated report still parses — into FEWER findings — so the
    // gate would read a clipped document as a cleaner repository. Same shape as
    // the heap guard's truncation defect fixed earlier in this release.
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = result.stdout.toString();
  const ranBadly = auditRunFailure({ ...result, stdout });
  if (ranBadly !== null) {
    log(`❌ ${ranBadly}`, 'red');
    process.exitCode = 1;
    return;
  }
  const findings = parseAuditFindings(stdout);
  const gate = classifyFindings(findings);
  reportDebt(gate);
  reportFailures(gate);
  if (gate.unexpected.length > 0 || gate.staleExemptions.length > 0) {
    process.exitCode = 1;
    return;
  }
  log(`✅ vat audit clean: ${gate.excused.length} finding(s) excused by declared reason.`, 'green');
}

if (isEntrypoint(import.meta.url)) main();
