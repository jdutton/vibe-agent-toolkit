/**
 * The command registry is a set of claims about vat's command line, and every
 * one of them is falsifiable against vat's own sources:
 *
 * - **Which exit codes mean the run finished its work.** vat's convention is `0`
 *   success, `1` validation findings, `2` system error. A command that reports
 *   findings by exit code must accept `1` or it is unmeasurable on any project
 *   that has findings — which is every real project, and was the defect. A
 *   command documented as always exiting `0` must NOT accept `1`, because for it
 *   a `1` really is something going wrong.
 * - **Which take a subject path.** `vat validate` and `vat verify` reject a
 *   positional path (exit 2) and scope themselves from the config at the working
 *   directory, which the harness sets to the subject. A `{subject}` token in
 *   either would make every repeat a usage error.
 * - **What a bare run measures.** `DEFAULT_MEASURED_COMMANDS` is a named
 *   selection from the registry, and its membership and order are what every
 *   already-stored report measured. Growing the registry must not disturb it.
 */

import { describe, expect, it } from 'vitest';

import {
  completedExitCodesOf,
  DEFAULT_COMPLETED_EXIT_CODES,
  DEFAULT_MEASURED_COMMANDS,
  MEASURABLE_COMMAND_NAMES,
  MEASURABLE_COMMANDS,
  measurableCommand,
  type MeasuredCommandSpec,
} from '../src/harness/commands.js';
import { SUBJECT_TOKEN } from '../src/harness/repeat.js';

/** vat's system-error code, which no command may ever declare completed. */
const SYSTEM_ERROR_EXIT = 2;

/** The `vat claude context --all` sweep, by registry name. */
const CONTEXT_SWEEP = 'claude-context-all';

/** The single-path control arm for that sweep, by registry name. */
const CONTEXT_ONE = 'claude-context';

/** What a bare run measures, in this order. */
const DEFAULT_NAMES = ['resources-scan', 'resources-validate', 'audit'];

/** The two commands spelled as a bare verb, because both reject a positional path. */
const PATHLESS_NAMES = ['validate', 'verify'];

/**
 * Every command that takes its scope from the working directory.
 *
 * Wider than {@link PATHLESS_NAMES}: `claude-context-all` carries a `--all` flag
 * as well as its verb, so it is not spelled as the bare verb, but it takes no
 * subject positional either. A `{subject}` token in any of these would make
 * every repeat a usage error.
 */
const CWD_SCOPED_NAMES = [...PATHLESS_NAMES, CONTEXT_SWEEP];

/** Every command handed the subject as a positional argument. */
const SUBJECT_NAMES = [...DEFAULT_NAMES, CONTEXT_ONE];

/** Every command that reports findings by exit code, and so completes at 1. */
const FINDINGS_NAMES = ['resources-validate', 'validate', 'verify'];

/** Every command documented as exiting 0 whatever it finds. */
const ALWAYS_ZERO_NAMES = ['resources-scan', 'audit', CONTEXT_SWEEP, CONTEXT_ONE];

/** The paired arms that make `vat claude context`'s cost separable. */
const CONTEXT_NAMES = [CONTEXT_SWEEP, CONTEXT_ONE];

/**
 * The registry's spec for a name, or a failure naming the name.
 *
 * Throwing rather than casting: a lookup that started returning `undefined`
 * should fail as a missing command, not as a confusing assertion on `undefined`.
 *
 * @param name - A registry key
 * @returns That command's spec
 * @throws {Error} when the registry does not know the name
 */
function specNamed(name: string): MeasuredCommandSpec {
  const spec = measurableCommand(name);
  if (spec === undefined) throw new Error(`the registry has no command named '${name}'`);
  return spec;
}

describe('completedExitCodesOf', () => {
  it('defaults a spec that says nothing to 0 alone', () => {
    const spec: MeasuredCommandSpec = { name: 'quiet', args: ['quiet'] };

    expect(completedExitCodesOf(spec)).toEqual([0]);
    expect(DEFAULT_COMPLETED_EXIT_CODES).toEqual([0]);
  });

  it('returns what the spec declared when it declared something', () => {
    const spec: MeasuredCommandSpec = { name: 'loud', args: ['loud'], completedExitCodes: [0, 1] };

    expect(completedExitCodesOf(spec)).toEqual([0, 1]);
  });
});

describe('MEASURABLE_COMMANDS', () => {
  it.each(FINDINGS_NAMES)('completes at 0 AND 1 for %s — findings are a finished run', (name) => {
    expect(completedExitCodesOf(specNamed(name))).toEqual([0, 1]);
  });

  it.each(ALWAYS_ZERO_NAMES)('completes only at 0 for %s — it never exits 1 on purpose', (name) => {
    expect(completedExitCodesOf(specNamed(name))).toEqual([0]);
  });

  it('never lets any command declare vat\'s system-error code completed', () => {
    for (const name of MEASURABLE_COMMAND_NAMES) {
      expect(completedExitCodesOf(specNamed(name))).not.toContain(SYSTEM_ERROR_EXIT);
    }
  });

  it.each(PATHLESS_NAMES)('spells %s as the bare verb — it rejects a positional path', (name) => {
    expect(specNamed(name).args).toEqual([name]);
  });

  it.each(CWD_SCOPED_NAMES)('gives %s no subject token — it scopes from the cwd', (name) => {
    expect(specNamed(name).args).not.toContain(SUBJECT_TOKEN);
  });

  it.each(SUBJECT_NAMES)('gives %s the subject to operate on', (name) => {
    expect(specNamed(name).args).toContain(SUBJECT_TOKEN);
  });

  it('answers to every name it lists, and to nothing else', () => {
    expect(MEASURABLE_COMMAND_NAMES).toEqual(Object.keys(MEASURABLE_COMMANDS));
    expect(measurableCommand('nonesuch')).toBeUndefined();
    // A name from Object.prototype must not resolve to a spec — the lookup is a
    // registry, not a property probe.
    expect(measurableCommand('toString')).toBeUndefined();
  });
});

describe('DEFAULT_MEASURED_COMMANDS', () => {
  it('is exactly the three corpus-enumerating verbs, in this order', () => {
    // Pinned rather than derived: changing membership or order changes what
    // every stored report is understood to have measured.
    expect(DEFAULT_MEASURED_COMMANDS.map((spec) => spec.name)).toEqual(DEFAULT_NAMES);
  });

  it('holds the very specs the registry holds, not copies of them', () => {
    // Identity, so a future edit cannot leave the registry and the default set
    // saying different things about the same command's accepted exit codes.
    expect(DEFAULT_MEASURED_COMMANDS[1]).toBe(MEASURABLE_COMMANDS['resources-validate']);
  });

  it('admits nothing the registry adds beyond those three', () => {
    // Derived rather than a second hand-written list, so a registry entry added
    // tomorrow is checked by this the day it lands.
    const members = new Set(DEFAULT_MEASURED_COMMANDS.map((spec) => spec.name));
    const extras = MEASURABLE_COMMAND_NAMES.filter((name) => !DEFAULT_NAMES.includes(name));

    expect(extras.filter((name) => members.has(name))).toEqual([]);
  });
});

describe('the vat claude context arms', () => {
  it('registers both, so the sweep and its single-path control are measurable', () => {
    expect(Object.keys(MEASURABLE_COMMANDS)).toEqual(expect.arrayContaining(CONTEXT_NAMES));
    expect(MEASURABLE_COMMAND_NAMES).toEqual(expect.arrayContaining(CONTEXT_NAMES));
    for (const name of CONTEXT_NAMES) expect(specNamed(name).name).toBe(name);
  });

  it('sweeps with --all and nothing else — --all takes no subject positional', () => {
    expect(specNamed(CONTEXT_SWEEP).args).toEqual(['claude', 'context', '--all']);
  });

  it('gives the control arm exactly one subject path', () => {
    expect(specNamed(CONTEXT_ONE).args).toEqual(['claude', 'context', SUBJECT_TOKEN]);
  });

  it.each(CONTEXT_NAMES)('leaves %s on the default completed exit codes', (name) => {
    // `vat claude context` is documented "0 - An answer was produced (there is
    // no threshold and no gate)"; its `1` is invalid usage, which is a run that
    // measured nothing. Accepting `1` here would time a usage error.
    expect(completedExitCodesOf(specNamed(name))).toBe(DEFAULT_COMPLETED_EXIT_CODES);
  });
});
