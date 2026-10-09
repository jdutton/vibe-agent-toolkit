/**
 * What must be true after any injected run, whatever the errno.
 *
 * Pure: snapshots and an outcome in, a list of violations out. Every violation starts
 * with its invariant's name (`I1`..`I9`).
 *
 * Keys in every snapshot and in `units` / `registered` share one space: paths relative to
 * the case root (the temp-dir snapshot is keyed relative to the temp dir itself).
 */

import { fsFaultRefusal } from '@vibe-agent-toolkit/schema';
import { fsFaultOf, isFsFaultError, isLayoutFault, toForwardSlash, toForwardSlashAnyPlatform, type FsFaultClass, type FsFaultError } from '@vibe-agent-toolkit/utils';
import { diffSnapshots, subtree, type FsCall, type TreeSnapshot } from '@vibe-agent-toolkit/utils/testing';

import { PLUGIN_KEPT_SIBLING_UNEXAMINED } from '../../src/commands/claude/plugin/kept-findings.js';

import type { Side } from './select.js';

/** A finding's code, and the path it is about (its `link`, else its `location`): a case-root key (`home/...`) when under the case root, else as published. */
export interface PublishedFinding {
  readonly code: string;
  readonly path?: string;
}

export interface VerbOutcome {
  /** `undefined` when the verb never called `process.exit`, which is a success. */
  exitCode: number | undefined;
  /** The registered refusal code the report carries, if any. */
  refusal: string | undefined;
  /** The refusal's message: residue it names is accounted for. */
  message: string | undefined;
  /** The messages of the report's warning findings. */
  warnings: readonly string[];
  /** Every finding the report published, any severity; absent when the run published none to read. */
  findings?: readonly PublishedFinding[];
  stdout: string;
  stderr: string;
  /**
   * The thrown value the published refusal was built from (what the refusal path handed
   * `errorMessageOf` last before the verb's first exit, or what escaped the verb); absent when
   * nothing was observed. I8 reads it.
   */
  thrown?: unknown;
  /** The refusals of the report's `data.phases` entries that ended in error (an orchestrator's phases); absent when it has none. */
  phaseRefusals?: readonly { readonly name: string; readonly code: string; readonly message: string }[];
  /**
   * What a refusal's report claims finished: `false` for nothing (its `data` is null, as
   * `NOTHING_FINISHED` publishes), `true` for work it lists. Absent when there is no refusal report to read.
   */
  claimsFinished?: boolean;
}

export interface CaseEvidence {
  before: TreeSnapshot;
  after: TreeSnapshot;
  /** The uninjected run's after-state. */
  golden: TreeSnapshot;
  sourcesBefore: TreeSnapshot;
  sourcesAfter: TreeSnapshot;
  /** TMPDIR before the run: what is already there (a cache a verb clears) is not the run's residue. */
  tmpBefore: TreeSnapshot;
  /** TMPDIR after the run. */
  tmpAfter: TreeSnapshot;
  /** Atomic units: each must end byte-equal to BEFORE or to GOLDEN. */
  units: readonly string[];
  outcome: VerbOutcome;
  fired: readonly FsCall[];
  /** Fired calls that came after the verb's first `process.exit`: code the real process never runs. */
  firedAfterExit?: readonly FsCall[];
  /** The units the registry names after the run; absent when the verb keeps no registry. */
  registered?: readonly string[];
  /** The one fault the run was injected with: the side its rule declares, and its errno. Absent for an uninjected run. */
  injected?: { readonly side: Side; readonly errno: string };
  /** The refusal I8 judges when it is not the top level's: a declared composite's failed phase (`composite.ts`). */
  refusalOfRecord?: string;
  /** The case DECLARES that its verb classifies a write with `shapeFromSource` (`VerbCase.shapeFromSource`); never inferred. */
  shapeFromSource?: boolean;
  /** The case DECLARES that its verb publishes a packager's source fault as the {@link PACKAGING_FAILED} finding (`VerbCase.packagingFinding`); never inferred. */
  packagingFinding?: boolean;
  /** The case DECLARES a presence preflight (`VerbCase.presencePreflight`): the path it probes, and the refusal "absent" is there; never inferred. */
  presencePreflight?: { readonly path: string; readonly refusal: string };
}

/** A staged copy (`.vat-staged-`), a skills scratch dir (`.vat-skills-`) or a parked prior tree (`.previous`). */
const isResidueName = (segment: string): boolean =>
  segment.includes('.vat-staged-') || segment.startsWith('.vat-skills-') || segment.endsWith('.previous');
const isResidue = (key: string): boolean => toForwardSlashAnyPlatform(key).split('/').some(isResidueName);
const ROOT_KEY = '.';
/** The `refusal` the driver records for a run that exited non-zero without publishing a parseable report. */
export const NO_REPORT = 'NO_REPORT';

const same = (a: TreeSnapshot, b: TreeSnapshot): boolean => diffSnapshots(a, b).length === 0;
const underAny = (key: string, units: readonly string[]): boolean => units.some((unit) => key === unit || key.startsWith(`${unit}/`));
const unitEquals = (a: TreeSnapshot, b: TreeSnapshot, unit: string): boolean => same(subtree(a, unit), subtree(b, unit));

/** The topmost keys of `snapshot` that are staging or parking residue. */
function residueKeys(snapshot: TreeSnapshot): string[] {
  const hits = [...snapshot.keys()].filter((key) => isResidue(key));
  return hits.filter((key) => !hits.some((other) => other !== key && key.startsWith(`${other}/`)));
}

function withoutResidueAndUnits(snapshot: TreeSnapshot, units: readonly string[]): TreeSnapshot {
  return new Map([...snapshot].filter(([key]) => !underAny(key, units) && !isResidue(key)));
}

/** What the run said: its warnings and its refusal's message. Residue either names is accounted for (C16). */
const statementsOf = (e: CaseEvidence): string[] => [...e.outcome.warnings, ...(e.outcome.message === undefined ? [] : [e.outcome.message])];

function unnamedResidue(keys: readonly string[], before: TreeSnapshot, e: CaseEvidence): string[] {
  const statements = statementsOf(e);
  return keys.filter((key) => !before.has(key) && !statements.some((statement) => statement.includes(key)));
}

/**
 * Whether `statement` names the path whose last segment is `segment`: `/<segment>` ending there (at the
 * end, before a space or other punctuation, or before a sentence's closing period) — not a longer name
 * that begins like it, nor a path inside it.
 */
function namesSegment(statement: string, segment: string): boolean {
  const needle = `/${segment}`;
  for (let at = statement.indexOf(needle); at !== -1; at = statement.indexOf(needle, at + 1)) {
    const next = statement.slice(at + needle.length, at + needle.length + 2);
    if (!/^[\w/-]/.test(next) && !/^\.\S/.test(next)) return true;
  }
  return false;
}

/**
 * What the run left in TMPDIR that nothing names. A top-level entry a WARNING names (the staging
 * directory a verb made and could not remove, reported as a leftover) accounts for everything inside it
 * (C16): its files are that directory's, never residue of their own. Any statement still names a key itself.
 */
function unnamedTmpResidue(keys: readonly string[], e: CaseEvidence): string[] {
  // Only a WARNING (a leftover finding) accounts for a subtree: a refusal message names the path that
  // failed, which is no report that the tree under it was left (controller ruling).
  const namedTop = (key: string): boolean => {
    const top = toForwardSlashAnyPlatform(key).split('/')[0] ?? key;
    return e.outcome.warnings.some((warning) => namesSegment(toForwardSlashAnyPlatform(warning), top));
  };
  return unnamedResidue(keys.filter((key) => !namedTop(key)), e.tmpBefore, e);
}

/**
 * `snapshot` without the residue the run named. A unit is judged by what it holds for the user: a
 * parked entry the run could not remove, and said so, is I6's (accepted), never a change to the unit
 * it sits in. Residue nobody names stays in, so it still makes its unit "neither".
 */
function withoutNamedResidue(snapshot: TreeSnapshot, e: CaseEvidence): TreeSnapshot {
  const statements = statementsOf(e);
  const named = residueKeys(snapshot).filter((key) => statements.some((statement) => statement.includes(key)));
  if (named.length === 0) return snapshot;
  return new Map([...snapshot].filter(([key]) => !underAny(key, named)));
}

/** The staged or parked entry `path` is, or lies in: its path up to and including the first residue segment. */
function residueRootOf(path: string): string | undefined {
  const segments = toForwardSlashAnyPlatform(path).split('/');
  const at = segments.findIndex((segment) => isResidueName(segment));
  return at === -1 ? undefined : segments.slice(0, at + 1).join('/');
}

/**
 * The directories the run kept because a sibling could not be examined (ruling R7 d-I-1), each named by a
 * {@link PLUGIN_KEPT_SIBLING_UNEXAMINED} finding at its EXACT path: by code and path, never by message text.
 */
const keptForSibling = (e: CaseEvidence): ReadonlySet<string> =>
  new Set((e.outcome.findings ?? []).flatMap((finding) => (finding.code === PLUGIN_KEPT_SIBLING_UNEXAMINED && finding.path !== undefined ? [finding.path] : [])));

/** `snapshot` without each directory {@link keptForSibling} names: what the run said it kept is neither judged nor a change it half-made. */
function withoutKeptForSibling(snapshot: TreeSnapshot, e: CaseEvidence): TreeSnapshot {
  const kept = [...keptForSibling(e)];
  return kept.length === 0 ? snapshot : new Map([...snapshot].filter(([key]) => !underAny(key, kept)));
}

function exitedZero(e: CaseEvidence): string[] {
  const failures: string[] = [];
  // A kept directory is out of the comparison on BOTH sides: golden may hold it too (a case alias of the new install).
  const after = withoutKeptForSibling(withoutNamedResidue(e.after, e), e);
  const golden = withoutKeptForSibling(e.golden, e);
  for (const unit of e.units) {
    if (!unitEquals(after, golden, unit)) failures.push(`I3: exit 0 but unit ${unit} is not the golden state:\n${diffSnapshots(subtree(golden, unit), subtree(after, unit)).join('\n')}`);
  }
  for (const call of e.fired) {
    const residue = call.family === 'remove' ? residueRootOf(call.path) : undefined;
    if (residue === undefined) continue;
    // A refused removal the run retried and finished left nothing: there is nothing for a warning to name.
    const left = [...e.after.keys()].some((key) => residue.endsWith(`/${key}`));
    const named = e.outcome.warnings.some((warning) => warning.includes(residue));
    if (left && !named) failures.push(`I3: exit 0 after a failed remove of ${residue} that no warning names`);
  }
  return failures;
}

function exitedNonZero(e: CaseEvidence): string[] {
  const failures: string[] = [];
  const after = withoutNamedResidue(e.after, e);
  for (const unit of e.units) {
    if (!unitEquals(after, e.before, unit) && !unitEquals(after, e.golden, unit)) {
      failures.push(`I4: unit ${unit} is neither its prior state nor the golden state (a half-applied change):\n${diffSnapshots(subtree(e.before, unit), subtree(after, unit)).join('\n')}`);
    }
  }
  // A directory the run made on the way to a unit (`~/.claude/plugins/` for `plugins/marketplaces/x`) is named on its own,
  // apart from a stray file or tree outside the units, which stays the general violation below.
  const ancestors = newAncestorDirectories(e);
  if (ancestors.length > 0) failures.push(`I4: a refused run left bare ancestor directories of its units: ${ancestors.join(', ')}.`);
  const afterOutside = new Map([...withoutResidueAndUnits(e.after, e.units)].filter(([key]) => !ancestors.includes(key)));
  const outside = diffSnapshots(withoutResidueAndUnits(e.before, e.units), afterOutside);
  if (outside.length > 0) failures.push(`I4: a refused run changed the watched tree outside its units:\n${outside.join('\n')}`);
  return failures;
}

/** Directories the run created that are ancestors of a unit, sorted: the parents a write to that unit makes first. */
function newAncestorDirectories(e: CaseEvidence): string[] {
  const isAncestor = (key: string): boolean => e.units.some((unit) => unit.startsWith(`${key}/`));
  return [...e.after]
    .filter(([key, entry]) => entry.kind === 'dir' && !e.before.has(key) && isAncestor(key))
    .map(([key]) => key)
    .toSorted((a, b) => a.localeCompare(b));
}

function registryAgrees(e: CaseEvidence): string[] {
  if (e.registered === undefined) return [];
  const registered = new Set(e.registered);
  const kept = keptForSibling(e);
  // A unit the run kept and named is held on purpose with its registry entry gone (ruling R7 d-I-1).
  return e.units.filter((unit) => !kept.has(unit)).flatMap((unit) => {
    const present = subtree(e.after, unit).size > 0;
    if (present === registered.has(unit)) return [];
    return [`I7: the registry ${registered.has(unit) ? 'names' : 'does not name'} ${unit} but the tree ${present ? 'holds' : 'does not hold'} it`];
  });
}

/**
 * The refusals the table allows for the injected fault: its row for the injected side and the
 * injected errno's class, read with the origin the verb classified. A shape fault on a write
 * whose layout an input decided — a layout fault (`isLayoutFault`) — may also be that input's (`source`, origin `content`, as
 * `shapeFromSource` reports it) — only when the case DECLARES `shapeFromSource`, and only with
 * exactly that signature. The signature alone proves nothing: a verb that classifies every read
 * as source/content by wrapper produces it too.
 */
function owedRefusals(injected: NonNullable<CaseEvidence['injected']>, faultClass: FsFaultClass, thrown: FsFaultError, declared: boolean): string[] {
  const owed = [fsFaultRefusal(injected.side, faultClass, thrown.origin).refusal];
  const promoted = declared && injected.side !== 'source' && isLayoutFault({ faultClass, errno: injected.errno }) && thrown.side === 'source' && thrown.origin === 'content';
  if (promoted) owed.push(fsFaultRefusal('source', faultClass, 'content').refusal);
  return [...new Set(owed)];
}

/**
 * The finding every packaging lane publishes a packager's source-side fault as
 * (`isSkillPackagingInputError`): the table's `INPUT_UNREADABLE`, said about the skill.
 */
const PACKAGING_FAILED = 'SKILL_PACKAGING_FAILED';

/** The stop a lane that cannot continue publishes beside {@link PACKAGING_FAILED}. */
const LANE_STOP = 'RUN_INCOMPLETE';

/**
 * Whether the run published the fault as {@link PACKAGING_FAILED} where the table owes
 * `INPUT_UNREADABLE` — only for a case that DECLARES it, only for a fault the verb put on
 * the source side, and only when that finding is in the report. The lane's own top-level
 * refusal must be none (a findings exit) or the stop it folds the finding into
 * ({@link LANE_STOP}): any other refusal is a re-code.
 */
function publishedAsPackagingFinding(e: CaseEvidence, owed: readonly string[], thrown: FsFaultError): boolean {
  const refusal = e.refusalOfRecord ?? e.outcome.refusal;
  const laneStop = refusal === undefined || refusal === LANE_STOP;
  return e.packagingFinding === true && laneStop && thrown.side === 'source' && owed.includes('INPUT_UNREADABLE')
    && (e.outcome.findings ?? []).some((finding) => finding.code === PACKAGING_FAILED);
}

/**
 * Whether the run refused as the case's DECLARED presence preflight answers "absent": only for an
 * `absent`-class injection the verb classified as absent, at exactly the declared path, with exactly
 * the declared refusal. An injected absence at the path a verb probes for its precondition cannot be
 * told from the file really being absent, so the precondition's answer is the honest one there.
 */
function answeredByPresencePreflight(e: CaseEvidence, faultClass: FsFaultClass, thrown: FsFaultError, refusal: string | undefined): boolean {
  const preflight = e.presencePreflight;
  return preflight !== undefined && faultClass === 'absent' && thrown.faultClass === 'absent' && refusal === preflight.refusal
    && thrown.path !== undefined && toForwardSlash(thrown.path) === toForwardSlash(preflight.path);
}

const MAX_CAUSE_DEPTH = 10;

/** The classified fault `value` is, or wraps somewhere down its `cause` chain (bounded: a cyclic chain must not hang a test). */
function classifiedFaultIn(value: unknown): FsFaultError | undefined {
  let current = value;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === 'object' && current !== null; depth++) {
    if (isFsFaultError(current)) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * I9: a refusal's claim of what finished agrees with the tree. "Nothing finished" needs every unit
 * at its prior state (residue the run named aside): a unit at golden under that claim is work a
 * script will believe was undone. For a verb that keeps a registry, a claim of finished work needs
 * some unit to have changed — unless finishing changes nothing (golden is the prior state).
 */
function claimAgrees(e: CaseEvidence): string[] {
  const claim = e.outcome.claimsFinished;
  if ((e.outcome.exitCode ?? 0) === 0 || claim === undefined) return [];
  const after = withoutNamedResidue(e.after, e);
  const changed = e.units.filter((unit) => !unitEquals(after, e.before, unit));
  if (!claim) return changed.map((unit) => `I9: the refusal claims nothing finished but unit ${unit} is not its prior state`);
  // Only where finishing changes something: an idempotent re-install that finished (golden = prior) and
  // then refused on a leftover claims finished work truly, with every unit at its prior state.
  const finishingChanges = e.units.some((unit) => !unitEquals(e.golden, e.before, unit));
  if (e.registered !== undefined && finishingChanges && changed.length === 0) return ['I9: the refusal claims work finished but every unit is its prior state'];
  return [];
}

/**
 * I8: a refused run whose refusal was built from a classified fault refuses as the table says for
 * what was injected. A wrapper that carries the fault as a cause and re-codes it is judged the same
 * way: re-coding a classified fault to another refusal is forbidden.
 */
function refusalOwedByTable(e: CaseEvidence): string[] {
  const { injected, outcome } = e;
  const thrown = classifiedFaultIn(outcome.thrown);
  if ((outcome.exitCode ?? 0) === 0 || injected === undefined || thrown === undefined) return [];
  const faultClass = fsFaultOf({ code: injected.errno })?.faultClass;
  if (faultClass === undefined) throw new Error(`fault matrix: injected errno ${injected.errno} has no fault class`);
  const owed = owedRefusals(injected, faultClass, thrown, e.shapeFromSource === true);
  const refusal = e.refusalOfRecord ?? outcome.refusal;
  if (refusal !== undefined && owed.includes(refusal)) return [];
  if (publishedAsPackagingFinding(e, owed, thrown)) return [];
  if (answeredByPresencePreflight(e, faultClass, thrown, refusal)) return [];
  return [`I8: refused ${refusal ?? 'nothing'} but the table owes ${owed.join(' or ')} for the injected ${injected.side} ${faultClass} fault (${injected.errno}); the verb classified ${thrown.side}/${thrown.faultClass}/${thrown.origin} (${thrown.errno})`];
}

/**
 * Check one injected run against every invariant.
 *
 * I1 no INTERNAL_ERROR and no NO_REPORT (a non-zero exit with no readable report, or more than one report for one exit). I2 the injection fired, and before the verb's first exit (else the case is vacuous). I3 exit 0 means every
 * unit is golden. I4 a refusal leaves every unit before-or-golden and the rest of the watched
 * tree untouched. I5 sources never change. I6 nothing new left behind (in TMPDIR or as staging residue) unless named.
 * Residue the run's message or warnings name is I6's alone: I3, I4 and I9 judge a unit without it, so a parked
 * entry a refusal names never makes the unit it sits in "half-applied" (ruled beyond C16). I7 the tree and
 * the registry agree about each unit. I9 a refusal's claim of what finished agrees with the tree. I8 a refusal built from a classified fault (`FsFaultError`, itself or down the cause
 * chain of what was thrown) is the refusal the schema table owes the injected side and the injected errno's class — or,
 * for a case that declares it, the packaging finding that stands for the table's `INPUT_UNREADABLE`.
 *
 * @returns Human lines, each starting with its invariant; empty means the run is sound
 */
export function violations(e: CaseEvidence): string[] {
  const found: string[] = [];
  if (e.outcome.refusal === 'INTERNAL_ERROR' || e.outcome.refusal === NO_REPORT) found.push(`I1: the verb ended in ${e.outcome.refusal} (${e.outcome.message ?? 'no message'})`);
  if (e.fired.length === 0) found.push('I2: injection never fired, so this case proves nothing');
  if ((e.firedAfterExit ?? []).length > 0) found.push('I2: the injection fired after the verb\'s first exit, on a path the real process never runs, so this case proves nothing');
  found.push(...((e.outcome.exitCode ?? 0) === 0 ? exitedZero(e) : exitedNonZero(e)), ...claimAgrees(e));
  const sources = diffSnapshots(e.sourcesBefore, e.sourcesAfter);
  if (sources.length > 0) found.push(`I5: a source tree changed:\n${sources.join('\n')}`);
  const tmp = [...e.tmpAfter.keys()].filter((key) => key !== ROOT_KEY);
  for (const key of unnamedTmpResidue(tmp, e)) found.push(`I6: ${key} was left in TMPDIR`);
  for (const key of unnamedResidue(residueKeys(e.after), e.before, e)) found.push(`I6: staging residue ${key} was left behind and nothing names it`);
  found.push(...registryAgrees(e));
  found.push(...refusalOwedByTable(e));
  return found;
}
