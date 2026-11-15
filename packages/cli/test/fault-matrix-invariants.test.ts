/**
 * `violations`: each invariant fires on exactly one constructed violation, so none is
 * vacuous. Pure — hand-built snapshots, no fs.
 */
import { FsFaultError, type FsFaultClass, type FsSide, type SourceOrigin } from '@vibe-agent-toolkit/utils';
import type { FsCall } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';

import { PLUGIN_KEPT_SIBLING_UNEXAMINED } from '../src/commands/claude/plugin/kept-findings.js';

import { violations, type CaseEvidence } from './fault-matrix/invariants.js';

const file = (sha256: string) => ({ kind: 'file' as const, mode: 0o644, sha256 });
const dir = () => ({ kind: 'dir' as const, mode: 0o755 });
const snap = (entries: Record<string, ReturnType<typeof file> | ReturnType<typeof dir>>) => new Map(Object.entries(entries));

const OLD = snap({ 'home/skills/s': dir(), 'home/skills/s/SKILL.md': file('old') });
const NEW = snap({ 'home/skills/s': dir(), 'home/skills/s/SKILL.md': file('new') });
const STAGED = 'home/skills/.s.vat-staged-x';

const firedWrite: FsCall = { seq: 1, op: 'write', family: 'write', api: 'sync', path: '/c/home/skills/.s.vat-staged-x/SKILL.md' };

const base = (): CaseEvidence => ({
  before: OLD, after: OLD, golden: NEW,
  sourcesBefore: snap({}), sourcesAfter: snap({}), tmpBefore: snap({}), tmpAfter: snap({}),
  units: ['home/skills/s'],
  outcome: { exitCode: 2, refusal: 'RUN_INCOMPLETE', message: 'ran out of space', warnings: [], stdout: '', stderr: '' },
  fired: [firedWrite],
});
const withOutcome = (o: Partial<CaseEvidence['outcome']>): CaseEvidence => ({ ...base(), outcome: { ...base().outcome, ...o } });
const only = (code: string) => [expect.stringContaining(code)];

describe('violations', () => {
  it('passes a refused run that left the unit as it was', () => {
    expect(violations(base())).toEqual([]);
  });

  it('passes a refused run whose unit already reached golden', () => {
    expect(violations({ ...base(), after: NEW })).toEqual([]);
  });

  it('passes a clean success: exit 0 and the unit is golden', () => {
    expect(violations({ ...withOutcome({ exitCode: 0, refusal: undefined }), after: NEW })).toEqual([]);
  });

  it('treats a run that never called process.exit as exit 0', () => {
    expect(violations(withOutcome({ exitCode: undefined, refusal: undefined }))).toEqual(only('I3'));
  });

  it('I1: INTERNAL_ERROR is never an acceptable refusal', () => {
    expect(violations(withOutcome({ refusal: 'INTERNAL_ERROR' }))).toEqual(only('I1'));
  });

  it('I1: a run that ended non-zero without a parseable report is a violation', () => {
    expect(violations(withOutcome({ refusal: 'NO_REPORT' }))).toEqual(only('I1'));
  });

  it('I2: a case whose injection never fired is vacuous', () => {
    expect(violations({ ...base(), fired: [] })).toEqual([expect.stringContaining('injection never fired')]);
  });

  it('I3: exit 0 with a unit that is not golden', () => {
    expect(violations(withOutcome({ exitCode: 0, refusal: undefined }))).toEqual(only('I3'));
  });

  it('I3: exit 0 after a remove fault on a staged path that no warning names, the residue still there', () => {
    const fired: FsCall = { seq: 2, op: 'rm', family: 'remove', api: 'sync', path: `/c/${STAGED}/inner` };
    const after = new Map([...NEW, [STAGED, dir()]]);
    expect(violations({ ...withOutcome({ exitCode: 0, refusal: undefined }), after, fired: [fired] })).toEqual([expect.stringContaining('I3'), expect.stringContaining('I6')]);
  });

  // The primitive retries a removal the OS refused (after giving the owner rwx): a refusal it
  // recovered from left nothing to name, so there is nothing a warning owes.
  it('I3: an exit 0 whose refused removal of a staged path was retried and is gone is fine', () => {
    const fired: FsCall = { seq: 2, op: 'rm', family: 'remove', api: 'sync', path: `/c/${STAGED}` };
    expect(violations({ ...withOutcome({ exitCode: 0, refusal: undefined }), after: NEW, fired: [fired] })).toEqual([]);
  });

  it('I3: that same exit 0 is fine once a warning names the staged entry (and the residue is named too)', () => {
    const fired: FsCall = { seq: 2, op: 'rm', family: 'remove', api: 'sync', path: `/c/${STAGED}/inner` };
    const after = new Map([...NEW, [STAGED, dir()]]);
    const outcome = { exitCode: 0, refusal: undefined, warnings: [`could not remove /c/${STAGED}`] };
    expect(violations({ ...withOutcome(outcome), after, fired: [fired] })).toEqual([]);
  });

  it('I4: a unit that is neither before nor golden (half-replaced)', () => {
    expect(violations({ ...base(), after: snap({}) })).toEqual(only('I4'));
  });

  it('I4: something outside the units changed on a refused run', () => {
    const after = new Map([...OLD, ['home/skills/other', dir()]]);
    expect(violations({ ...base(), after })).toEqual(only('I4'));
  });

  it('I4: new bare directories that are ancestors of a unit are their own violation, naming each one', () => {
    const fresh = { ...base(), before: snap({}), units: ['home/a/b/unit'] };
    const found = violations({ ...fresh, after: snap({ 'home': dir(), 'home/a': dir(), 'home/a/b': dir() }) });
    expect(found).toEqual([expect.stringMatching(/^I4: a refused run left bare ancestor directories of its units: home, home\/a, home\/a\/b\.$/)]);
  });

  it('I4: a stray entry beside new ancestor directories is still the general outside-the-units violation', () => {
    const fresh = { ...base(), before: snap({}), units: ['home/a/b/unit'] };
    const found = violations({ ...fresh, after: snap({ 'home': dir(), 'home/a': dir(), 'home/stray': file('x'), 'home/a/other': dir() }) });
    expect(found).toEqual([
      expect.stringContaining('left bare ancestor directories of its units: home, home/a.'),
      expect.stringMatching(/outside its units:\n\+ home\/a\/other \(dir mode 755\)\n\+ home\/stray/),
    ]);
  });

  it('I4: staging residue outside the units is I6\'s concern, not a second I4', () => {
    const after = new Map([...OLD, [STAGED, dir()]]);
    expect(violations({ ...base(), after })).toEqual(only('I6'));
  });

  // A remove whose parked entry would not go is a refusal naming that entry, the user's path already
  // golden; when the parked entry sits inside a larger unit (a plugin dir parked inside its
  // marketplace), the unit is golden but for residue the run named — I6's to judge, never a half-applied unit.
  it('I4/I3: residue inside a unit that the run names is not a change to the unit; residue nobody names still is', () => {
    const parked = 'home/skills/.s.vat-staged-x.previous';
    const units = ['home/skills'];
    const after = new Map([['home/skills', dir()], [parked, dir()], [`${parked}/SKILL.md`, file('old')]]);
    const refused = { ...base(), units, golden: snap({ 'home/skills': dir() }), after };
    expect(violations({ ...refused, outcome: { ...base().outcome, message: `could not remove /c/${parked}` } })).toEqual([]);
    expect(violations(refused)).toEqual([expect.stringContaining('I4: unit home/skills is neither'), expect.stringContaining('I6')]);
    const succeeded = { ...refused, outcome: { ...base().outcome, exitCode: 0, refusal: undefined, message: undefined, warnings: [`left /c/${parked}`] } };
    expect(violations(succeeded)).toEqual([]);
  });

  it('I5: a source tree that changed', () => {
    expect(violations({ ...base(), sourcesBefore: snap({ 'src/a': file('1') }), sourcesAfter: snap({ 'src/a': file('2') }) })).toEqual(only('I5'));
  });

  it('I6: anything left in TMPDIR', () => {
    expect(violations({ ...base(), tmpAfter: snap({ 'vat-x': dir() }) })).toEqual(only('I6'));
  });

  // `vat cache clear` works on a tree that lives in TMPDIR: what it failed to remove was there before the run.
  it('I6: what was in TMPDIR before the run is not this run\'s residue; a new entry beside it is', () => {
    const cache = snap({ '.vat-cache': dir(), '.vat-cache/a.json': file('a') });
    expect(violations({ ...base(), tmpBefore: cache, tmpAfter: cache })).toEqual([]);
    expect(violations({ ...base(), tmpBefore: cache, tmpAfter: new Map([...cache, ['vat-x', dir()]]) })).toEqual([expect.stringContaining('I6: vat-x was left')]);
  });

  // After the first exit the stub keeps running code the real process never reaches: a fault there judges nothing.
  it('I2: an injection that fired after the verb\'s first exit', () => {
    expect(violations({ ...base(), firedAfterExit: [firedWrite] })).toEqual([expect.stringContaining('I2: the injection fired after the verb\'s first exit')]);
    expect(violations({ ...base(), firedAfterExit: [] })).toEqual([]);
  });

  // A run that names the staging directory it could not remove has named what is in it (C16): its
  // files are that directory's, never residue of their own. A sibling directory it did not name is.
  it('I6: a TMPDIR directory a warning names accounts for everything inside it, and for nothing beside it', () => {
    const left = snap({ 'vat-x-1': dir(), 'vat-x-1/package': dir(), 'vat-x-1/package/a.json': file('a'), 'vat-y-2': dir() });
    const named = withOutcome({ warnings: ['could not remove the temporary directory /c/tmp/vat-x-1. Remove it yourself.'] });
    expect(violations({ ...named, tmpAfter: left })).toEqual([expect.stringContaining('I6: vat-y-2 was left')]);
    // A name that only begins like it is not it.
    const prefix = withOutcome({ warnings: ['could not remove the temporary directory /c/tmp/vat-x-12'] });
    expect(violations({ ...prefix, tmpAfter: snap({ 'vat-x-1': dir(), 'vat-x-1/a.json': file('a') }) })).toContainEqual(expect.stringContaining('I6: vat-x-1/a.json was left'));
    // A refusal message naming the directory (the failing path) is not a report that its tree was left:
    // only a WARNING (a leftover finding) accounts for a subtree (controller ruling).
    const refusedAt = withOutcome({ message: 'could not extract into /c/tmp/vat-x-1. Free disk space.' });
    expect(violations({ ...refusedAt, tmpAfter: snap({ 'vat-x-1': dir(), 'vat-x-1/a.json': file('a') }) })).toContainEqual(expect.stringContaining('I6: vat-x-1/a.json was left'));
    // Naming a file INSIDE it (the write that failed) is not saying the directory was left.
    const inside = withOutcome({ message: 'could not write /c/tmp/vat-x-1/a.json' });
    expect(violations({ ...inside, tmpAfter: snap({ 'vat-x-1': dir(), 'vat-x-1/b.json': file('b') }) })).toContainEqual(expect.stringContaining('I6: vat-x-1/b.json was left'));
  });

  it('I6: the TMPDIR root entry itself is not residue', () => {
    expect(violations({ ...base(), tmpAfter: snap({ '.': dir() }) })).toEqual([]);
  });

  it('I6: staged residue in the tree that nothing names', () => {
    const after = new Map([...OLD, [STAGED, dir()], [`${STAGED}/SKILL.md`, file('x')]]);
    expect(violations({ ...base(), after })).toEqual(only('I6'));
  });

  it('I6: parked .previous and .vat-skills- residue count too', () => {
    for (const name of ['home/skills/s.previous', 'home/skills/.vat-skills-abc']) {
      expect(violations({ ...base(), after: new Map([...OLD, [name, dir()]]) })).toEqual(only('I6'));
    }
  });

  it('I6: residue named by a warning is accepted', () => {
    const after = new Map([...OLD, [STAGED, dir()]]);
    expect(violations({ ...withOutcome({ warnings: [`left behind: /c/${STAGED}`] }), after })).toEqual([]);
  });

  it('I6: residue named by the refusal message is accepted (C16)', () => {
    const after = new Map([...OLD, [STAGED, dir()]]);
    expect(violations({ ...withOutcome({ message: `could not clean /c/${STAGED}` }), after })).toEqual([]);
  });

  it('I6: residue that was already in BEFORE is not this run\'s', () => {
    const before = new Map([...OLD, [STAGED, dir()]]);
    expect(violations({ ...base(), before, after: before })).toEqual([]);
  });

  it('I6: a warning naming a different path does not excuse the residue', () => {
    const after = new Map([...OLD, [STAGED, dir()]]);
    expect(violations({ ...withOutcome({ warnings: ['left behind: /c/home/skills/.t.vat-staged-y'] }), after })).toEqual(only('I6'));
  });

  it('I7: the registry names a unit the tree does not hold', () => {
    expect(violations({ ...base(), before: snap({}), after: snap({}), registered: ['home/skills/s'] })).toEqual(only('I7'));
  });

  it('I7: the tree holds a unit the registry does not name', () => {
    expect(violations({ ...base(), registered: [] })).toEqual(only('I7'));
  });

  // Ruling R7 d-I-1: a directory that may alias a sibling the OS refused to examine is kept, never
  // deleted, and the run names it — by code and exact path — while the registry entry goes.
  describe('a directory kept because a sibling could not be examined', () => {
    const KEPT = 'home/skills/s';
    const keptRun = (findings: CaseEvidence['outcome']['findings']): CaseEvidence => ({
      ...withOutcome({ exitCode: 0, refusal: undefined, findings }),
      golden: snap({}),
      registered: [],
    });

    it('is accounted for in I3 and I7 when a PLUGIN_KEPT_SIBLING_UNEXAMINED finding names its exact path', () => {
      expect(violations(keptRun([{ code: PLUGIN_KEPT_SIBLING_UNEXAMINED, path: KEPT }]))).toEqual([]);
    });

    it('still fails I3 and I7 when no such finding names it: another code, another path, or a path inside it', () => {
      for (const findings of [
        [{ code: 'PLUGIN_UNINSTALL_INCOMPLETE', path: KEPT }],
        [{ code: PLUGIN_KEPT_SIBLING_UNEXAMINED, path: 'home/skills/t' }],
        [{ code: PLUGIN_KEPT_SIBLING_UNEXAMINED, path: `${KEPT}/SKILL.md` }],
        [],
      ]) {
        expect(violations(keptRun(findings))).toEqual([expect.stringContaining('I3'), expect.stringContaining('I7')]);
      }
    });
  });

  it('I7: agreeing registry and tree pass; no registry means no claim', () => {
    expect(violations({ ...base(), registered: ['home/skills/s'] })).toEqual([]);
    expect(violations(base())).toEqual([]);
  });

  // A refusal reports what finished. "Nothing finished" over a run whose change already landed (the
  // uninstall that rewrote the registry, then could not delete a parked tree) tells a script the
  // plugin is still installed when it is not; I4 passes it, because golden is an allowed end state.
  it('I9: a refusal that claims nothing finished while a unit reached golden lies', () => {
    expect(violations({ ...withOutcome({ claimsFinished: false }), after: NEW })).toEqual([expect.stringContaining('I9: the refusal claims nothing finished but unit home/skills/s')]);
  });

  it('I9: a registry verb\'s refusal that claims work finished while every unit is its prior state lies', () => {
    expect(violations({ ...withOutcome({ claimsFinished: true }), registered: ['home/skills/s'] })).toEqual([expect.stringContaining('I9: the refusal claims work finished')]);
  });

  // An idempotent re-install finishes, changing nothing, then refuses on a post-commit leftover: its claim is true.
  it('I9: a finished claim over a run whose golden is its prior state is not a lie', () => {
    expect(violations({ ...withOutcome({ claimsFinished: true }), golden: OLD, registered: ['home/skills/s'] })).toEqual([]);
  });

  it('I9: claims that agree with the tree pass; an exit 0 and an unread claim make none', () => {
    expect(violations(withOutcome({ claimsFinished: false }))).toEqual([]);
    expect(violations({ ...withOutcome({ claimsFinished: true }), after: NEW, registered: ['home/skills/s'] })).toEqual([]);
    expect(violations({ ...withOutcome({ claimsFinished: true }), after: NEW })).toEqual([]);
    expect(violations({ ...withOutcome({ exitCode: 0, refusal: undefined, claimsFinished: false }), after: NEW })).toEqual([]);
  });
});

/** An `FsFaultError` as a verb's classifier would have thrown it. */
const fault = (side: FsSide, faultClass: FsFaultClass, errno: string, origin: SourceOrigin = 'argument'): FsFaultError =>
  new FsFaultError({ side, faultClass, errno, path: '/c/x', origin, action: 'touch x', cause: undefined });

/** A refused run, injected with `errno` on `side`, that published `refusal` from `thrown`. */
const refused = (injected: { side: FsSide; errno: string }, refusal: string, thrown: unknown): CaseEvidence => ({
  ...withOutcome({ refusal, thrown }),
  injected,
});

describe('I8: a refusal built from a classified fault is the table\'s refusal for the injected side and class', () => {
  it('passes the table\'s own answer', () => {
    expect(violations(refused({ side: 'destination', errno: 'ENOSPC' }, 'RUN_INCOMPLETE', fault('destination', 'exhausted', 'ENOSPC')))).toEqual([]);
    expect(violations(refused({ side: 'source', errno: 'EACCES' }, 'INPUT_UNREADABLE', fault('source', 'refused', 'EACCES')))).toEqual([]);
  });

  it('fires on a refusal the table does not owe, naming both', () => {
    const found = violations(refused({ side: 'source', errno: 'EMFILE' }, 'INPUT_UNREADABLE', fault('source', 'exhausted', 'EMFILE')));
    expect(found).toEqual(['I8: refused INPUT_UNREADABLE but the table owes RUN_INCOMPLETE for the injected source exhausted fault (EMFILE); the verb classified source/exhausted/argument (EMFILE)']);
  });

  it('fires when the verb put the fault on the wrong side (role by wrapper, not by path)', () => {
    const found = violations(refused({ side: 'destination', errno: 'EACCES' }, 'INPUT_UNREADABLE', fault('source', 'refused', 'EACCES')));
    expect(found).toEqual(only('I8: refused INPUT_UNREADABLE but the table owes RUN_INCOMPLETE for the injected destination refused fault'));
  });

  it('reads an absent source by the origin the verb classified it with', () => {
    expect(violations(refused({ side: 'source', errno: 'ENOENT' }, 'CONFIG_INVALID', fault('source', 'absent', 'ENOENT', 'config')))).toEqual([]);
    expect(violations(refused({ side: 'source', errno: 'ENOENT' }, 'USAGE_INVALID', fault('source', 'absent', 'ENOENT', 'config')))).toEqual(only('I8'));
  });

  it('accepts a layout fault an input decided, when the case DECLARES shapeFromSource: source, origin content', () => {
    const promoted = refused({ side: 'environment', errno: 'EISDIR' }, 'INPUT_UNREADABLE', fault('source', 'wrong-type', 'EISDIR', 'content'));
    expect(violations({ ...promoted, shapeFromSource: true })).toEqual([]);
  });

  // ENOTDIR on a write is a file in the way of the layout, at any depth: keyed on the errno, not its `absent` class.
  it('accepts a promoted ENOTDIR (a file in the way) on a declared case', () => {
    const inTheWay = refused({ side: 'destination', errno: 'ENOTDIR' }, 'INPUT_UNREADABLE', fault('source', 'absent', 'ENOTDIR', 'content'));
    expect(violations({ ...inTheWay, shapeFromSource: true })).toEqual([]);
  });

  // A refused or vanished write target is the destination's, whatever an input's layout decided.
  it('never accepts a promoted refused or absent fault, even on a declared case', () => {
    const refusedWrite = refused({ side: 'destination', errno: 'EACCES' }, 'INPUT_UNREADABLE', fault('source', 'refused', 'EACCES', 'content'));
    const vanished = refused({ side: 'destination', errno: 'ENOENT' }, 'INPUT_UNREADABLE', fault('source', 'absent', 'ENOENT', 'content'));
    expect(violations({ ...refusedWrite, shapeFromSource: true })).toEqual(only('I8'));
    expect(violations({ ...vanished, shapeFromSource: true })).toEqual(only('I8'));
  });

  it('never infers shapeFromSource from the signature: an undeclared case with that promotion is an I8 violation', () => {
    expect(violations(refused({ side: 'environment', errno: 'EACCES' }, 'INPUT_UNREADABLE', fault('source', 'refused', 'EACCES', 'content')))).toEqual(only('I8'));
    expect(violations(refused({ side: 'destination', errno: 'ENOENT' }, 'INPUT_UNREADABLE', fault('source', 'absent', 'ENOENT', 'content')))).toEqual(only('I8'));
  });

  it('does not stretch that to a source of any other origin, even on a declared case', () => {
    const other = refused({ side: 'environment', errno: 'EACCES' }, 'INPUT_UNREADABLE', fault('source', 'refused', 'EACCES', 'argument'));
    expect(violations({ ...other, shapeFromSource: true })).toEqual(only('I8'));
  });

  // A packager's source-side fault is published by every packaging lane as the SKILL_PACKAGING_FAILED finding
  // (`isSkillPackagingInputError`): the finding IS the table's INPUT_UNREADABLE, said about the skill.
  describe('a declared packaging finding', () => {
    const PACKAGING_FAILED = 'SKILL_PACKAGING_FAILED';
    /** A run that published the findings coded `findingCodes`, with `refusal` at the top level (none: a findings exit). */
    const published = (injected: { side: FsSide; errno: string }, refusal: string | undefined, thrown: unknown, findingCodes: readonly string[]): CaseEvidence => {
      const run = refused(injected, refusal ?? '', thrown);
      return { ...run, outcome: { ...run.outcome, exitCode: refusal === undefined ? 1 : 2, refusal, findings: findingCodes.map((code) => ({ code })) } };
    };
    const sourceRefused = fault('source', 'refused', 'EACCES', 'content');

    it('accepts the finding where the table owes INPUT_UNREADABLE, with no refusal or the lane\'s own stop', () => {
      expect(violations({ ...published({ side: 'source', errno: 'EACCES' }, undefined, sourceRefused, [PACKAGING_FAILED]), packagingFinding: true })).toEqual([]);
      expect(violations({ ...published({ side: 'source', errno: 'EACCES' }, 'RUN_INCOMPLETE', sourceRefused, [PACKAGING_FAILED]), packagingFinding: true })).toEqual([]);
    });

    it('accepts it for a bundle-layout fault only when the case declares shapeFromSource too', () => {
      const layout = published({ side: 'destination', errno: 'EISDIR' }, undefined, fault('source', 'wrong-type', 'EISDIR', 'content'), [PACKAGING_FAILED]);
      expect(violations({ ...layout, packagingFinding: true, shapeFromSource: true })).toEqual([]);
      expect(violations({ ...layout, packagingFinding: true })).toEqual(only('I8'));
    });

    it('never infers it: an undeclared case, or a declared one that published no such finding, is an I8 violation', () => {
      expect(violations(published({ side: 'source', errno: 'EACCES' }, undefined, sourceRefused, [PACKAGING_FAILED]))).toEqual(only('I8'));
      expect(violations({ ...published({ side: 'source', errno: 'EACCES' }, undefined, sourceRefused, ['LINK_BROKEN']), packagingFinding: true })).toEqual(only('I8'));
    });

    // The finding stands in for INPUT_UNREADABLE only beside no refusal, or beside the lane's own stop.
    it('never excuses a top-level refusal other than RUN_INCOMPLETE', () => {
      expect(violations({ ...published({ side: 'source', errno: 'EACCES' }, 'USAGE_INVALID', sourceRefused, [PACKAGING_FAILED]), packagingFinding: true }))
        .toEqual(only('I8'));
    });

    it('is never the answer to a capacity fault, which the table owes RUN_INCOMPLETE', () => {
      const exhausted = published({ side: 'source', errno: 'EMFILE' }, undefined, fault('source', 'exhausted', 'EMFILE', 'content'), [PACKAGING_FAILED]);
      expect(violations({ ...exhausted, packagingFinding: true })).toEqual(only('I8'));
    });
  });

  describe('a declared presence preflight', () => {
    // The preflight's own `stat` of the config: an injected ENOENT there IS a config that is not there.
    const preflight = { path: '/c/x', refusal: 'CONFIG_INVALID' } as const;
    const absentConfig = refused({ side: 'destination', errno: 'ENOENT' }, 'CONFIG_INVALID', fault('destination', 'absent', 'ENOENT'));

    it('accepts the declared refusal for an absent fault at the declared path, only when declared', () => {
      expect(violations({ ...absentConfig, presencePreflight: preflight })).toEqual([]);
      expect(violations(absentConfig)).toEqual(only('I8'));
    });

    it('rejects any other class at the declared path: a refused probe is not "absent"', () => {
      const refusedConfig = refused({ side: 'destination', errno: 'EACCES' }, 'CONFIG_INVALID', fault('destination', 'refused', 'EACCES'));
      expect(violations({ ...refusedConfig, presencePreflight: preflight })).toEqual(only('I8'));
    });

    it('rejects an absent fault at any other path, and any other refusal for it', () => {
      expect(violations({ ...absentConfig, presencePreflight: { ...preflight, path: '/c/elsewhere' } })).toEqual(only('I8'));
      expect(violations({ ...absentConfig, presencePreflight: { ...preflight, refusal: 'USAGE_INVALID' } })).toEqual(only('I8'));
    });
  });

  it('judges by the INJECTED errno\'s class, whatever errno the verb ended up classifying', () => {
    const found = violations(refused({ side: 'source', errno: 'EMFILE' }, 'INPUT_UNREADABLE', fault('source', 'refused', 'EACCES')));
    expect(found).toEqual(only('I8: refused INPUT_UNREADABLE but the table owes RUN_INCOMPLETE for the injected source exhausted fault (EMFILE)'));
  });

  it('an occupied destination at the syscall is the run stopping, never the user\'s (the preflight owns that)', () => {
    expect(violations(refused({ side: 'destination', errno: 'EEXIST' }, 'RUN_INCOMPLETE', fault('destination', 'occupied', 'EEXIST')))).toEqual([]);
    expect(violations(refused({ side: 'destination', errno: 'EEXIST' }, 'USAGE_INVALID', fault('destination', 'occupied', 'EEXIST')))).toEqual(only('I8'));
  });

  it('judges the refusal of record when there is one (a declared composite\'s failed phase), not the fold', () => {
    const fold = refused({ side: 'source', errno: 'EACCES' }, 'RUN_INCOMPLETE', fault('source', 'refused', 'EACCES'));
    expect(violations({ ...fold, refusalOfRecord: 'INPUT_UNREADABLE' })).toEqual([]);
    expect(violations({ ...fold, refusalOfRecord: 'USAGE_INVALID' })).toEqual(only('I8: refused USAGE_INVALID but the table owes INPUT_UNREADABLE'));
  });

  it('finds a classified fault down the cause chain: re-coding one to another refusal fires', () => {
    const recoded = new Error('could not install', { cause: new Error('wrapped', { cause: fault('destination', 'refused', 'EACCES') }) });
    expect(violations(refused({ side: 'destination', errno: 'EACCES' }, 'USAGE_INVALID', recoded))).toEqual(only('I8: refused USAGE_INVALID but the table owes RUN_INCOMPLETE'));
    expect(violations(refused({ side: 'destination', errno: 'EACCES' }, 'RUN_INCOMPLETE', recoded))).toEqual([]);
  });

  it('does not apply to a refusal built from anything else, to a success, or to a run with no injection', () => {
    const coded = new Error('legacy coded refusal', { cause: Object.assign(new Error('x'), { code: 'EMFILE' }) });
    expect(violations(refused({ side: 'source', errno: 'EMFILE' }, 'INPUT_UNREADABLE', coded))).toEqual([]);
    const success = { ...refused({ side: 'destination', errno: 'EACCES' }, 'INPUT_UNREADABLE', fault('source', 'refused', 'EACCES')), after: NEW };
    expect(violations({ ...success, outcome: { ...success.outcome, exitCode: 0 } })).toEqual([]);
    expect(violations(withOutcome({ refusal: 'INPUT_UNREADABLE', thrown: fault('source', 'refused', 'EACCES') }))).toEqual([]);
  });
});
