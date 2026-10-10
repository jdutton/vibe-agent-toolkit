/**
 * The one errno classifier: turns a raw `node:fs` error into an {@link FsFaultError}
 * that says WHICH SIDE of a verb the OS refused (`source`, `destination`,
 * `environment`) and WHAT KIND of refusal it was ({@link FsFaultClass}).
 *
 * The errno → class table and the single-errno questions (`isPathAbsentError`,
 * `isRenameContentionError`, …) live in the leaf `errno-table.ts`. This module
 * imports only that table and `vat-error.ts`, so the path helpers below it
 * (`path-utils.ts`: `normalizedTmpdir`) can classify their own faults. Deciding a
 * side by containment needs `path-containment.ts`, which imports `path-utils.ts`:
 * that is `fs-boundary.ts`, one level up, never imported back.
 *
 * `RefusalCode` lives in `schema`, so nothing here names one. The side × class →
 * refusal table (and the remedy prose) belongs to `schema`; this module only
 * produces the facts.
 */

import { type FsFaultClass, fsFaultOf, isFileInTheWayError } from './errno-table.js';
import { isVatError, VatError } from './vat-error.js';

/** The one code every classified filesystem refusal carries. */
export const FS_FAULT_CODE = 'FS_FAULT';

/**
 * Which side of a verb the OS refused: an input it reads (`source`), an output or
 * user state it writes (`destination`), or VAT's own scratch — staging, `$TMPDIR`,
 * caches, locks (`environment`).
 */
export type FsSide = (typeof FS_SIDES)[number];

/** Every {@link FsSide}, for a consumer that must key a table by them (the schema refusal table's drift test). */
export const FS_SIDES = ['source', 'destination', 'environment'] as const;

/** For a `source` fault, who named the input: a CLI argument, a config value, or content read from inside another input. */
export type SourceOrigin = (typeof SOURCE_ORIGINS)[number];

/** Every {@link SourceOrigin}. */
export const SOURCE_ORIGINS = ['argument', 'config', 'content'] as const;

/** A filesystem refusal, classified. The message carries no remedy: the schema table owns that prose. */
export class FsFaultError extends VatError {
  readonly side: FsSide;
  readonly faultClass: FsFaultClass;
  readonly errno: string;
  readonly path: string | undefined;
  readonly origin: SourceOrigin;
  readonly action: string;

  constructor(facts: {
    side: FsSide;
    faultClass: FsFaultClass;
    errno: string;
    path: string | undefined;
    origin: SourceOrigin;
    action: string;
    cause: unknown;
  }) {
    const where = facts.path === undefined ? '' : `: ${facts.path}`;
    super(FS_FAULT_CODE, `Could not ${facts.action} (${facts.errno})${where}`, { cause: facts.cause });
    this.side = facts.side;
    this.faultClass = facts.faultClass;
    this.errno = facts.errno;
    this.path = facts.path;
    this.origin = facts.origin;
    this.action = facts.action;
  }
}

/**
 * Whether `error` is an {@link FsFaultError}. Reads the VAT brand, the code and
 * the fields — never the prototype — so a `dist` copy still matches a `src`
 * instance, as {@link isVatError} does.
 */
export function isFsFaultError(error: unknown): error is FsFaultError {
  if (!isVatError(error, FS_FAULT_CODE)) return false;
  const fields = error as unknown as Record<string, unknown>;
  return typeof fields['side'] === 'string' && typeof fields['faultClass'] === 'string' && typeof fields['errno'] === 'string';
}

/** What a catch site knows about the call it wrapped. */
export interface FsFaultContext {
  side: FsSide;
  /** A verb phrase for the message: `read the skill source`, `write the plugin registry`. */
  action: string;
  /** Used only when the error names no path of its own. */
  path?: string;
  /** For a `source` fault; default `argument`. */
  origin?: SourceOrigin;
  /**
   * The write's LAYOUT was decided by an input (an archive extracted into staging, a
   * skill bundle's `files:` layout): a layout fault ({@link isLayoutFault}) — the
   * `wrong-type` and `occupied` classes (`EISDIR`, `EEXIST`: one entry landing on or
   * under another), and `ENOTDIR` on the write (a file in the way of a directory the
   * layout needs, at any depth) — is the input's, so it becomes `source`. Everything
   * else keeps the side: a refused output (`refused`), a vanished one (`ENOENT`) and
   * a machine that ran out (`exhausted`, `busy`, `unsupported`, `device`) say nothing
   * about the layout.
   */
  shapeFromSource?: boolean;
}

/** The classes an input's layout can decide. */
const LAYOUT_CLASSES: ReadonlySet<FsFaultClass> = new Set(['wrong-type', 'occupied']);

/**
 * Whether a fault on a write is one an input's layout decided — the only kind
 * `shapeFromSource` moves to `source`: a `wrong-type` or `occupied` class, or
 * `ENOTDIR` ({@link isFileInTheWayError}), keyed on the errno because the class
 * table files it under `absent`. `ENOENT` is never one: a vanished output.
 *
 * @param fault - The fault's class and errno, as {@link fsFaultOf} or an `FsFaultError` carries them
 */
export function isLayoutFault(fault: { readonly faultClass: FsFaultClass; readonly errno: string }): boolean {
  return LAYOUT_CLASSES.has(fault.faultClass) || isFileInTheWayError({ code: fault.errno });
}

/** The classes that are the machine or the filesystem giving out — nothing about an input's content or layout. */
const CAPACITY_CLASSES: ReadonlySet<FsFaultClass> = new Set(['exhausted', 'busy', 'unsupported', 'device']);

/**
 * Whether a fault is a CAPACITY fault: the machine ran out (`exhausted`), something
 * held the path (`busy`), or the filesystem cannot do this or failed (`unsupported`,
 * `device`). The refusal table stops the run (`RUN_INCOMPLETE`) for every one of them on a
 * destination or an environment side; reading an input it does so for `exhausted` and `busy`
 * only (the machine's own state), while an `unsupported` or `device` fault there is the
 * input's (`INPUT_UNREADABLE`). Among several failures of one operation it is the one to
 * report first: a full disk explains the entries that failed after it.
 *
 * @param fault - The fault's class, as {@link fsFaultOf} or an `FsFaultError` carries it
 */
export function isCapacityFault(fault: { readonly faultClass: FsFaultClass }): boolean {
  return CAPACITY_CLASSES.has(fault.faultClass);
}

/**
 * Classify `error`. Returns an {@link FsFaultError} for a filesystem errno, and the
 * input untouched for anything else — a `TypeError` is a defect, and an existing
 * {@link VatError} already says what it means.
 */
export function classifyFsFault(error: unknown, ctx: FsFaultContext): unknown {
  if (isVatError(error)) return error;
  const facts = fsFaultOf(error);
  if (facts === undefined) return error;
  const promoted = ctx.shapeFromSource === true && ctx.side !== 'source' && isLayoutFault(facts);
  const side = promoted ? 'source' : ctx.side;
  return new FsFaultError({
    side,
    faultClass: facts.faultClass,
    errno: facts.errno,
    path: facts.path ?? facts.dest ?? ctx.path,
    origin: ctx.origin ?? (ctx.shapeFromSource === true && side === 'source' ? 'content' : 'argument'),
    action: ctx.action,
    cause: error,
  });
}

/** Run `work`; a filesystem errno escaping it is rethrown classified, everything else as it was. */
export async function withFsFault<T>(ctx: FsFaultContext, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error: unknown) {
    throw classifyFsFault(error, ctx);
  }
}

/** Synchronous {@link withFsFault}. */
export function withFsFaultSync<T>(ctx: FsFaultContext, work: () => T): T {
  try {
    return work();
  } catch (error: unknown) {
    throw classifyFsFault(error, ctx);
  }
}
