/**
 * The fault harness's vocabulary, with no filesystem call in it: the errnos it raises, the
 * operations it traces and their families, a rule, the error a rule raises, and the JSON spec a
 * spawned process is handed (`VAT_FAULT_FS`). `fault-fs.ts` is the half that patches `node:fs`.
 *
 * ⛔ Framework-free, like everything under `testing/`.
 */

import { constants } from 'node:os';

/** Every errno the injector raises (`EDQUOT` too on a host whose `os.constants.errno` lacks it: it gets `-1`). */
export const INJECTED_ERRNOS = ['EACCES', 'EPERM', 'ENOSPC', 'EDQUOT', 'EROFS', 'EMFILE', 'ENFILE', 'ENOENT', 'EISDIR', 'ENOTDIR', 'EBUSY', 'EXDEV'] as const;
export type InjectedErrno = (typeof INJECTED_ERRNOS)[number];

const FS_OP_FAMILIES = ['read', 'write', 'meta', 'list', 'remove', 'rename', 'create'] as const;
export type FsOpFamily = (typeof FS_OP_FAMILIES)[number];
export type FsApi = 'sync' | 'callback' | 'promise' | 'handle' | 'stream';

export interface FaultRule {
  readonly family?: FsOpFamily;
  readonly op?: string;
  readonly path: (path: string) => boolean;
  /** 1-based among calls matching family / op / path. Default 1. */
  readonly nth?: number;
  readonly errno: InjectedErrno;
}

/**
 * Build the error Node would have thrown for `errno`.
 *
 * `errno` carries libuv's negative number (`-28` for `ENOSPC`) from `os.constants`;
 * a code the host lacks (`EDQUOT` on win32) gets `-1`.
 */
export function injectedErrnoError(errno: InjectedErrno, syscall: string, path: string): NodeJS.ErrnoException {
  const number = (constants.errno as Record<string, number | undefined>)[errno];
  return Object.assign(new Error(`${errno}: injected, ${syscall} '${path}'`), {
    errno: number === undefined ? -1 : -number,
    code: errno,
    syscall,
    path,
  });
}

export type PathShape = 'fd' | 'one' | 'two' | 'link';
export interface OpSpec {
  /** `'open'` is decided by the flags: a read-only open is `read`, anything else `write`. */
  readonly family: FsOpFamily | 'open';
  /** Where the path is: an fd, the first argument, the first two, or `symlink(target, path)`. */
  readonly shape: PathShape;
}

/** Every operation the harness traces and can fail; the three wrappers are generated from it. */
export const OPS: Readonly<Record<string, OpSpec>> = {
  open: { family: 'open', shape: 'one' },
  read: { family: 'read', shape: 'fd' },
  readv: { family: 'read', shape: 'fd' },
  readFile: { family: 'read', shape: 'one' },
  write: { family: 'write', shape: 'fd' },
  writev: { family: 'write', shape: 'fd' },
  writeFile: { family: 'write', shape: 'one' },
  appendFile: { family: 'write', shape: 'one' },
  copyFile: { family: 'write', shape: 'two' },
  cp: { family: 'write', shape: 'two' },
  truncate: { family: 'write', shape: 'one' },
  ftruncate: { family: 'write', shape: 'fd' },
  fsync: { family: 'write', shape: 'fd' },
  mkdir: { family: 'create', shape: 'one' },
  mkdtemp: { family: 'create', shape: 'one' },
  symlink: { family: 'create', shape: 'link' },
  link: { family: 'create', shape: 'two' },
  readdir: { family: 'list', shape: 'one' },
  opendir: { family: 'list', shape: 'one' },
  stat: { family: 'meta', shape: 'one' },
  lstat: { family: 'meta', shape: 'one' },
  fstat: { family: 'meta', shape: 'fd' },
  readlink: { family: 'meta', shape: 'one' },
  realpath: { family: 'meta', shape: 'one' },
  chmod: { family: 'meta', shape: 'one' },
  fchmod: { family: 'meta', shape: 'fd' },
  utimes: { family: 'meta', shape: 'one' },
  access: { family: 'meta', shape: 'one' },
  close: { family: 'meta', shape: 'fd' },
  rm: { family: 'remove', shape: 'one' },
  rmdir: { family: 'remove', shape: 'one' },
  unlink: { family: 'remove', shape: 'one' },
  rename: { family: 'rename', shape: 'two' },
};

/**
 * A {@link FaultRule} that can cross a process boundary as JSON: the path is matched by a
 * substring of its forward-slash form, since a predicate cannot be serialised.
 */
export interface FaultSpec {
  readonly family?: FsOpFamily;
  readonly op?: string;
  readonly pathIncludes: string;
  readonly nth?: number;
  readonly errno: InjectedErrno;
}

/** What `fault-fs-preload` reads from `VAT_FAULT_FS`: the session's root and its faults. */
export interface FaultFsSpec {
  readonly within: string;
  readonly faults: readonly FaultSpec[];
}

/** The rule a {@link FaultSpec} stands for; what the spec leaves out, the injector defaults. */
export function faultRuleOf(spec: FaultSpec): FaultRule {
  return {
    ...(spec.family === undefined ? {} : { family: spec.family }),
    ...(spec.op === undefined ? {} : { op: spec.op }),
    path: (path) => path.includes(spec.pathIncludes),
    ...(spec.nth === undefined ? {} : { nth: spec.nth }),
    errno: spec.errno,
  };
}

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T => (values as readonly unknown[]).includes(value);

/** An op the harness traces, of the family the spec names (an `open` is either: its flags decide). */
function isTracedOp(op: unknown, family: FsOpFamily | undefined): boolean {
  if (op === undefined) return true;
  const spec = typeof op === 'string' && Object.hasOwn(OPS, op) ? OPS[op] : undefined;
  if (spec === undefined) return false;
  return family === undefined || spec.family === 'open' || spec.family === family;
}

/**
 * A fault the injector can raise exactly as written: a known family, a traced op of that family,
 * a positive `nth`, an errno it raises, a substring to match. Anything else would run the process
 * with a rule that never fires, which is the process unfaulted.
 */
function isFaultSpec(value: unknown): value is FaultSpec {
  if (typeof value !== 'object' || value === null) return false;
  const { family, op, pathIncludes, nth, errno } = value as Partial<Record<keyof FaultSpec, unknown>>;
  if (family !== undefined && !isOneOf(FS_OP_FAMILIES, family)) return false;
  return isTracedOp(op, family)
    && typeof pathIncludes === 'string'
    && (nth === undefined || (Number.isInteger(nth) && (nth as number) > 0))
    && isOneOf(INJECTED_ERRNOS, errno);
}

/**
 * Parse the `VAT_FAULT_FS` JSON a spawned process is handed.
 *
 * @throws Error naming the variable when the text is not JSON, has no `within`, or holds a fault
 *   the injector cannot raise as written: a malformed spec must not run the process unfaulted
 */
export function faultFsSpecOf(text: string): FaultFsSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`VAT_FAULT_FS is not JSON: ${(error as Error).message}`, { cause: error });
  }
  const { within, faults } = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Partial<Record<keyof FaultFsSpec, unknown>>;
  if (typeof within !== 'string' || !Array.isArray(faults) || !faults.every((fault) => isFaultSpec(fault))) {
    throw new Error(`VAT_FAULT_FS must be {"within": "<dir>", "faults": [{"family"?, "op"?, "pathIncludes", "nth"?, "errno"}, ...]} with a known family, `
      + `an op the injector traces (of that family), a positive nth and an errno it raises (${INJECTED_ERRNOS.join(', ')}); got ${text}`);
  }
  return { within, faults };
}
