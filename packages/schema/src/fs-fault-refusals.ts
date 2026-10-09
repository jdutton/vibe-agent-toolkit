/**
 * Which refusal a classified filesystem fault is: the one side × class table every verb's
 * filesystem refusal is decided by.
 *
 * `@vibe-agent-toolkit/utils` classifies a raw errno into an `FsFaultError` carrying a `side`,
 * a `faultClass` and (for a source) an `origin`; it cannot name a refusal, because
 * {@link RefusalCode} lives here. This table turns those facts into the code, the cause and the
 * remedy, so no verb restates errno prose and no two verbs disagree about the same fault.
 *
 * The vocabulary keys below are the ones utils produces. Schema carries no workspace runtime
 * dependency, so they are spelled here rather than imported: the CLI's `refusalCodeOf` passes
 * utils' types into {@link fsFaultRefusal} (a class utils adds and this table lacks fails its
 * typecheck), and the CLI's unit tests walk every errno utils classifies against these keys
 * (a class this table carries and utils never produces fails there).
 *
 * The grid is published in `docs/validation-codes.md` under `<!-- fs-fault-refusals -->`; a unit
 * test holds the two equal.
 */

import type { RefusalCode } from './validation-codes.js';

/** What kind of thing the OS refused, whichever side it happened on. */
export type FsFaultRefusalClass = 'absent' | 'refused' | 'exhausted' | 'wrong-type' | 'occupied' | 'busy' | 'unsupported' | 'device';

/** Which side of a verb the fault is on: an input it reads, an output or user state it writes, or VAT's own scratch. */
export type FsFaultRefusalSide = 'source' | 'destination' | 'environment';

/** For a source fault, who named the input: a CLI argument, a config value, or content inside another input. */
export type FsFaultRefusalOrigin = 'argument' | 'config' | 'content';

/** One cell of the table: the refusal, why it happened, and what the user does about it. */
export interface FsFaultRefusalRow {
  readonly refusal: RefusalCode;
  readonly remedy: string;
  readonly cause: string;
}

type ClassRows = Readonly<Record<FsFaultRefusalClass, FsFaultRefusalRow>>;

/** What the OS said, as the second half of a cause sentence. */
const WHAT_HAPPENED: Readonly<Record<FsFaultRefusalClass, string>> = {
  absent: 'nothing was at the path',
  refused: 'the operating system refused permission',
  exhausted: 'the machine ran out of disk space, quota or open files',
  'wrong-type': 'the path was not the kind of entry the operation needs (a directory for a file, a link loop, a name too long)',
  occupied: 'something was already in the way at the path',
  busy: 'the path was busy or temporarily unavailable',
  unsupported: 'the filesystem cannot do this (read-only, across devices, or an operation it does not support)',
  device: 'the disk or network filesystem failed',
};

/** The two machine faults: nothing about the input or the output is wrong, so the remedy is the same on every side. */
const MACHINE_REMEDY = {
  exhausted: 'Free disk space, quota or open files on this machine, then re-run.',
  busy: 'Wait for whatever holds the path to release it, then re-run.',
} as const;

const SOURCE_REMEDY: Readonly<Record<Exclude<FsFaultRefusalClass, 'absent' | keyof typeof MACHINE_REMEDY>, string>> = {
  refused: 'Grant read permission on the named input, or point the command at one it can read.',
  'wrong-type': 'Point the command at the kind of entry it expects; the message names what it found.',
  occupied: 'Remove what is in the way at the named input path.',
  unsupported: 'Move the input to a filesystem that supports the operation the message names.',
  device: 'Check the disk or network share holding the input, then re-run.',
  ...MACHINE_REMEDY,
};

const ABSENT_SOURCE: Readonly<Record<FsFaultRefusalOrigin, { refusal: RefusalCode; remedy: string }>> = {
  argument: { refusal: 'USAGE_INVALID', remedy: 'Correct the path argument; it names nothing.' },
  config: { refusal: 'CONFIG_INVALID', remedy: 'Fix the path in vibe-agent-toolkit.config.yaml; it names nothing.' },
  content: { refusal: 'INPUT_UNREADABLE', remedy: 'Restore the file the input refers to, or remove the reference.' },
};

const DESTINATION_REMEDY: Readonly<Record<FsFaultRefusalClass, string>> = {
  absent: 'Create the directory the output path needs, or choose another output path.',
  refused: 'Grant write permission on the named path, or choose another output path.',
  'wrong-type': 'Choose an output path that is the kind of entry the command writes.',
  occupied: 'Something appeared at the named path while the command wrote it (another process, or an interrupted earlier run); remove it and re-run.',
  unsupported: 'Write the output to a writable filesystem that supports the operation the message names.',
  device: 'Check the disk or network share holding the output, then re-run.',
  ...MACHINE_REMEDY,
};

const ENVIRONMENT_REMEDY: Readonly<Record<FsFaultRefusalClass, string>> = {
  absent: 'Something removed VAT\'s scratch space while it ran; re-run.',
  refused: 'Make the temporary directory writable, or point TMPDIR at one that is.',
  'wrong-type': 'Remove the unexpected entry the message names from VAT\'s scratch space, then re-run.',
  occupied: 'Remove the leftover entry the message names from VAT\'s scratch space, then re-run.',
  unsupported: 'Point TMPDIR at a writable local filesystem.',
  device: 'Check the disk holding the temporary directory, then re-run.',
  ...MACHINE_REMEDY,
};

const SOURCE_SUBJECT: Readonly<Record<FsFaultRefusalOrigin, string>> = {
  argument: 'An input named on the command line',
  config: 'An input named in the project config',
  content: 'An input found inside another input',
};

const isMachineFault = (faultClass: FsFaultRefusalClass): faultClass is keyof typeof MACHINE_REMEDY => faultClass in MACHINE_REMEDY;

/** One row per class, spelled out: `satisfies` makes a missing or an extra class a compile error. */
function rowsOf(subject: string, decide: (faultClass: FsFaultRefusalClass) => { refusal: RefusalCode; remedy: string }): ClassRows {
  const row = (faultClass: FsFaultRefusalClass): FsFaultRefusalRow => ({ ...decide(faultClass), cause: `${subject} could not be used: ${WHAT_HAPPENED[faultClass]}.` });
  return Object.freeze({
    absent: row('absent'),
    refused: row('refused'),
    exhausted: row('exhausted'),
    'wrong-type': row('wrong-type'),
    occupied: row('occupied'),
    busy: row('busy'),
    unsupported: row('unsupported'),
    device: row('device'),
  } satisfies Record<FsFaultRefusalClass, FsFaultRefusalRow>);
}

function sourceRows(origin: FsFaultRefusalOrigin): ClassRows {
  return rowsOf(SOURCE_SUBJECT[origin], (faultClass) => {
    if (faultClass === 'absent') return ABSENT_SOURCE[origin];
    // A machine fault while READING is the machine's, not the input's: the input may be perfectly fine.
    if (isMachineFault(faultClass)) return { refusal: 'RUN_INCOMPLETE', remedy: MACHINE_REMEDY[faultClass] };
    return { refusal: 'INPUT_UNREADABLE', remedy: SOURCE_REMEDY[faultClass] };
  });
}

/**
 * The table. Every destination fault stops the run, `occupied` included: this table never infers
 * user intent, and an `EEXIST` / `ENOTEMPTY` raised by a syscall is a race or VAT's own sequencing
 * (a registry under `~/.claude`, a parked tree during a `--force` replace). "Something is in the way
 * of a destination the user named" is the invocation's mistake (`USAGE_INVALID`, `--force`
 * replaces it), but the tree-change primitive's preflight decides that before any syscall runs
 * (`TREE_DEST_OCCUPIED`); it never reaches this table.
 */
export const FS_FAULT_REFUSALS: {
  readonly source: Readonly<Record<FsFaultRefusalOrigin, ClassRows>>;
  readonly destination: ClassRows;
  readonly environment: ClassRows;
} = Object.freeze({
  source: Object.freeze({ argument: sourceRows('argument'), config: sourceRows('config'), content: sourceRows('content') }),
  destination: rowsOf('An output or user state the command writes', (faultClass) => ({
    refusal: 'RUN_INCOMPLETE',
    remedy: DESTINATION_REMEDY[faultClass],
  })),
  environment: rowsOf('VAT\'s own scratch space (staging, the temporary directory, a cache or a lock)', (faultClass) => ({
    refusal: 'RUN_INCOMPLETE',
    remedy: ENVIRONMENT_REMEDY[faultClass],
  })),
});

/**
 * The row for one classified fault.
 *
 * @param side - Which side of the verb the OS refused
 * @param faultClass - What kind of refusal it was
 * @param origin - Who named the input; read only for a `source` fault
 */
export function fsFaultRefusal(side: FsFaultRefusalSide, faultClass: FsFaultRefusalClass, origin: FsFaultRefusalOrigin): FsFaultRefusalRow {
  return side === 'source' ? FS_FAULT_REFUSALS.source[origin][faultClass] : FS_FAULT_REFUSALS[side][faultClass];
}
