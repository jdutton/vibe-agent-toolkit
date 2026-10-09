/**
 * Run one CLI verb in-process against a case's private tree, and take the
 * snapshots the invariants compare.
 *
 * Test code: raw `fs` is fine here, and it imports `vitest`.
 */

import { CODE_REGISTRY } from '@vibe-agent-toolkit/schema';
import { mkdirSyncReal, relativeEscapesRoot, safePath } from '@vibe-agent-toolkit/utils';
import { snapshotTree, type SnapshotEntry, type SnapshotRewrite, type StatRewrite, type TreeSnapshot } from '@vibe-agent-toolkit/utils/testing';
import type { Command } from 'commander';
import { vi } from 'vitest';
import * as YAML from 'yaml';

import type * as CommandRefusal from '../../src/utils/command-refusal.js';
import { captureCommand } from '../helpers/stdout-capture.js';

import type { RefusalOfRecord } from './composite.js';
import { NO_REPORT, type PublishedFinding, type VerbOutcome } from './invariants.js';
import './refusal-observer.js';
import { refusalTrail } from './refusal-trail.js';
import type { Roots } from './select.js';

export interface CaseRoot {
  root: string;
  home: string;
  tmp: string;
  project: string;
}

export interface VerbCase {
  /** Stable: `<family>/<lane>/<variant>`. */
  id: string;
  /** The command group, e.g. `createPluginCommand`. */
  group: () => Command;
  /** User args after the group name. */
  argv: (r: CaseRoot) => readonly string[];
  /** Builds prior state and inputs. */
  fixture: (r: CaseRoot) => void;
  /** Trees snapshotted before and after (e.g. `r.home/.claude`, an `--output`). */
  watched: (r: CaseRoot) => readonly string[];
  /** Atomic units, as keys relative to `r.root`: each must end byte-equal to BEFORE or to GOLDEN. */
  units: (r: CaseRoot) => readonly string[];
  /** Trees the verb reads: they must never change. */
  sources: (r: CaseRoot) => readonly string[];
  /** Extra content rewrites for this case's registry files (on top of root and timestamp normalisation). */
  rewrites?: (r: CaseRoot) => readonly SnapshotRewrite[];
  /**
   * What `stat` reports during every run of the case, golden and injected alike (`installFaultFs`'s
   * `rewrites`): a filesystem shape the host lacks, simulated — two spellings one entry, as on a
   * case-folding filesystem. Declared, never inferred.
   */
  statRewrites?: (r: CaseRoot) => readonly StatRewrite[];
  /** The units the registry names after the run, as keys relative to `r.root`; omit when the verb keeps none. */
  registered?: (r: CaseRoot) => readonly string[];
  /** Seams to set up before the run, e.g. `vi.mocked(downloadNpmPackage)` for the npm lane. */
  mocks?: (r: CaseRoot) => void;
  /** The working directory the verb runs in (a postinstall's package, an agent's package); restored after. */
  cwd?: (r: CaseRoot) => string;
  /**
   * The verb is an orchestrator whose refusal is a fold over its phases' reports: provenance and I8
   * judge its one failed phase (`composite.ts`). Declared, never inferred.
   */
  composite?: true;
  /**
   * The verb classifies a write whose layout an input decided with `shapeFromSource`, so I8 may
   * accept a shape fault reported as the source's (origin `content`). Declared, never inferred.
   */
  shapeFromSource?: true;
  /**
   * The verb publishes a packager's source-side fault as the `SKILL_PACKAGING_FAILED` finding
   * (`isSkillPackagingInputError`), so I8 may accept that finding where the table owes
   * `INPUT_UNREADABLE`. Declared, never inferred.
   */
  packagingFinding?: true;
  /**
   * The verb's presence preflight: it probes `path` for its precondition (a config it edits) and
   * refuses `refusal` when nothing is there. I8 accepts that refusal for an `absent` fault the verb
   * classified at exactly that path, and nothing else. Declared, never inferred.
   */
  presencePreflight?: (r: CaseRoot) => { readonly path: string; readonly refusal: string };
}

const REGISTRY_FILE = /\.(json|ya?ml)$/;
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T[\d:.]{8,12}Z/g;

/**
 * Mint the case's trees under `base` (a directory the suite already owns) and point
 * `HOME`, `TMPDIR` (and their Windows spellings) at them. `runVerb` undoes the stubs; a case
 * that never reaches it must call `vi.unstubAllEnvs()` itself.
 */
export function makeCaseRoot(base: string): CaseRoot {
  const r: CaseRoot = {
    root: base,
    home: safePath.join(base, 'home'),
    tmp: safePath.join(base, 'tmp'),
    project: safePath.join(base, 'project'),
  };
  for (const dir of [r.home, r.tmp, r.project]) mkdirSyncReal(dir, { recursive: true });
  vi.stubEnv('HOME', r.home);
  vi.stubEnv('TMPDIR', r.tmp);
  // Blank is unset to the Claude paths resolver: a developer's own CLAUDE_CONFIG_DIR must not aim a case at their ~/.claude.
  vi.stubEnv('CLAUDE_CONFIG_DIR', '');
  // The parse cache under TMPDIR is ambient state no verb here owns: its writes would be faulted, and it would be TMPDIR residue.
  vi.stubEnv('VAT_CACHE', '0');
  if (process.platform === 'win32') {
    vi.stubEnv('USERPROFILE', r.home);
    vi.stubEnv('TEMP', r.tmp);
    vi.stubEnv('TMP', r.tmp);
  }
  return r;
}

/** Where a case's trees are, as `selectInjectionPoints` wants them. */
export function rootsOf(c: VerbCase, r: CaseRoot): Roots {
  return { home: r.home, tmp: r.tmp, project: r.project, sources: c.sources(r) };
}

interface PublishedReport {
  error?: { code?: string; message?: string };
  findings?: { severity?: string; message?: string; code?: string }[];
  data?: { phases?: { name?: string; error?: { code?: string; message?: string } }[] } | null;
}

/** The failed entries of the report's `data.phases`, as `VerbOutcome.phaseRefusals`. */
function phaseRefusalsOf(report: PublishedReport | undefined): Pick<VerbOutcome, 'phaseRefusals'> {
  const phases = report?.data?.phases;
  if (!Array.isArray(phases)) return {};
  return {
    phaseRefusals: phases
      .filter((phase) => phase.error !== undefined)
      .map((phase) => ({ name: phase.name ?? '', code: phase.error?.code ?? '', message: phase.error?.message ?? '' })),
  };
}

/**
 * The verb's report: its one document, or (`exitCalls > 1`) the first of several, since a second
 * one is a catch that saw the exit stub's throw, which the real process (ended at the first exit)
 * never writes. `undefined` when nothing parses, or when one exit came with more than one document:
 * a verb owes ONE envelope.
 */
function parseReport(stdout: string, exitCalls: number): { report: PublishedReport | undefined; documents: number } {
  const documents = YAML.parseAllDocuments(stdout);
  const [first] = documents;
  // An unparseable document is a verb that published no report; runVerb turns that into NO_REPORT.
  if (first === undefined || !('errors' in first) || first.errors.length > 0) return { report: undefined, documents: documents.length };
  if (documents.length > 1 && exitCalls <= 1) return { report: undefined, documents: documents.length };
  const parsed: unknown = first.toJS();
  return { report: typeof parsed === 'object' && parsed !== null ? (parsed as PublishedReport) : undefined, documents: documents.length };
}

/**
 * The value the refusal path handed over last before the verb's first exit (`seen` entries of the
 * trail by then): the thrown value the published refusal was built from.
 */
function refusedWith(seen: number | undefined): { thrown?: unknown } {
  const count = seen ?? refusalTrail.length;
  return count === 0 ? {} : { thrown: refusalTrail[count - 1] };
}

const isRegisteredCode = (code: string): code is keyof typeof CODE_REGISTRY => Object.hasOwn(CODE_REGISTRY, code);

/**
 * Why `outcome.thrown` is not the value the published refusal was built from: the message the
 * refusal path derives from it (the unmocked `errorMessageOf`, then `withFsFaultRemedy`; the code's
 * own description when that is empty) differs from the message of `record` — the top level's, or a
 * declared composite's failed phase's (`composite.ts`). `undefined`
 * when they agree, or when there is no refusal or no observed value to compare. The observer
 * records every `errorMessageOf` call, so without this a stale earlier value would pass for the
 * refusal's — and I8 would judge the wrong error.
 */
export async function provenanceMismatch(outcome: VerbOutcome, record: RefusalOfRecord = { refusal: outcome.refusal, message: outcome.message, via: 'top level' }): Promise<string | undefined> {
  const { refusal } = record;
  if (!('thrown' in outcome) || refusal === undefined || refusal === NO_REPORT) return undefined;
  const actual = await vi.importActual<typeof CommandRefusal>('../../src/utils/command-refusal.js');
  const raw = actual.errorMessageOf(outcome.thrown);
  const description = isRegisteredCode(refusal) ? CODE_REGISTRY[refusal].description : raw;
  const expected = raw === '' ? description : actual.withFsFaultRemedy(raw, outcome.thrown);
  const where = record.via === 'top level' ? '' : ` (${record.via})`;
  return expected === record.message ? undefined : `published "${record.message ?? ''}"${where} but the observed thrown value gives "${expected}"`;
}

/**
 * Run the verb. A throw that escapes the command is an `INTERNAL_ERROR` outcome rather than a
 * test crash, so invariant I1 is the one that reports it. `onFirstExit` runs when the verb first
 * calls `process.exit`: where the real process ends.
 */
/** A published finding's code, and the path it is about (`link`, else `location`) as a case-root key (`home/...`) when under the case root. */
function findingOf(finding: { readonly code?: string; readonly link?: string; readonly location?: string }, r: CaseRoot): PublishedFinding {
  const { code = '' } = finding;
  const about = finding.link ?? finding.location;
  if (about === undefined) return { code };
  const relative = safePath.relative(r.root, about);
  return { code, path: relativeEscapesRoot(relative) || relative.length === 0 ? about : relative };
}

export async function runVerb(c: VerbCase, r: CaseRoot, onFirstExit?: () => void): Promise<VerbOutcome> {
  const cwd = process.cwd();
  refusalTrail.length = 0;
  let seenAtExit: number | undefined;
  const atFirstExit = (): void => {
    seenAtExit = refusalTrail.length;
    onFirstExit?.();
  };
  try {
    c.mocks?.(r);
    if (c.cwd !== undefined) process.chdir(c.cwd(r));
    let captured;
    try {
      captured = await captureCommand(() => c.group().parseAsync([...c.argv(r)], { from: 'user' }).then(() => undefined), atFirstExit);
    } catch (error) {
      // captureCommand swallows only the process.exit stub; anything else escaped the verb.
      return { exitCode: undefined, refusal: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error), warnings: [], stdout: '', stderr: '', thrown: error };
    }
    const { report, documents } = parseReport(captured.stdout, captured.exitCalls);
    const base = { stdout: captured.stdout, stderr: captured.stderr, ...refusedWith(seenAtExit) };
    const exitedNonZero = captured.exited !== undefined && captured.exited !== 0;
    if (report === undefined && (exitedNonZero || documents > 1)) {
      const what = documents > 1 ? `${documents} documents and ${captured.exitCalls} exit call(s)` : 'no parseable report';
      return { exitCode: captured.exited, refusal: NO_REPORT, message: `exit ${String(captured.exited)} with ${what}; stderr: ${captured.stderr.slice(0, 300)}`, warnings: [], ...base };
    }
    return {
      exitCode: captured.exited,
      refusal: report?.error?.code,
      message: report?.error?.message,
      warnings: (report?.findings ?? []).filter((finding) => finding.severity === 'warning').map((finding) => finding.message ?? ''),
      findings: (report?.findings ?? []).map((finding) => findingOf(finding, r)),
      ...phaseRefusalsOf(report),
      ...(report?.error === undefined ? {} : { claimsFinished: report.data !== null && report.data !== undefined }),
      ...base,
    };
  } finally {
    process.chdir(cwd);
    vi.unstubAllEnvs();
  }
}

/**
 * What differs between two runs by construction, not by behaviour: the case's own root in a
 * registry path (golden and injected cases live in different roots) and timestamps.
 */
function rewritesFor(c: VerbCase, r: CaseRoot): SnapshotRewrite[] {
  return [
    { applies: (key) => REGISTRY_FILE.test(key), rewrite: (text) => text.replaceAll(r.root, '<ROOT>').replaceAll(ISO_TIMESTAMP, '<TIMESTAMP>') },
    ...(c.rewrites?.(r) ?? []),
  ];
}

function snapshotAll(r: CaseRoot, paths: readonly string[], rewrites: readonly SnapshotRewrite[]): TreeSnapshot {
  const merged = new Map<string, SnapshotEntry>();
  for (const path of paths) {
    const relative = safePath.relative(r.root, path);
    for (const [key, entry] of snapshotTree(path, { rewrites, keyPrefix: relative === '' ? '.' : relative })) merged.set(key, entry);
  }
  return merged;
}

export interface CaseSnapshots {
  /** Every watched tree, keyed relative to `r.root`. */
  watched: TreeSnapshot;
  /** Every source tree, keyed relative to `r.root`. */
  sources: TreeSnapshot;
  /** The TMPDIR, keyed relative to itself (`.` is its root). */
  tmp: TreeSnapshot;
}

/** Take the three snapshots the invariants need; call once before the run and once after. */
export function snapshotCase(c: VerbCase, r: CaseRoot): CaseSnapshots {
  const rewrites = rewritesFor(c, r);
  return {
    watched: snapshotAll(r, c.watched(r), rewrites),
    sources: snapshotAll(r, c.sources(r), rewrites),
    tmp: snapshotTree(r.tmp),
  };
}
