import { randomBytes } from 'node:crypto';
import nodeFs, { rmSync, symlinkSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

import { isFilesystemAccessError } from './errors/errno.js';
import { normalizedTmpdir, safePath, toForwardSlash } from './path-utils.js';

declare const symlinkCapabilityBrand: unique symbol;

/**
 * Proof that this process can create filesystem symlinks.
 *
 * The only way to obtain one is {@link symlinkCapability}, and it exists at
 * all only when a real probe already succeeded — so a function that requires
 * this as a parameter cannot be reached by code that skipped the check. That
 * is the point of branding it rather than passing a `boolean`: forgetting the
 * check becomes a type error instead of a runtime `EPERM` on a machine you
 * don't control.
 */
export type SymlinkCapability = { readonly [symlinkCapabilityBrand]: true };

let cachedCapability: SymlinkCapability | null | undefined;

/**
 * The errnos that mean "this host cannot create symlinks": Windows without
 * Developer Mode or `SeCreateSymbolicLinkPrivilege` (`EPERM`), and a
 * filesystem that has no symlinks to offer (`ENOTSUP` / `EOPNOTSUPP`).
 */
const SYMLINK_UNSUPPORTED_ERRNOS: ReadonlySet<string> = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP']);

function isSymlinkUnsupported(error: unknown): boolean {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' && SYMLINK_UNSUPPORTED_ERRNOS.has(error.code);
}

/**
 * Whether this PROCESS can create symlinks — probed once and memoized.
 *
 * On Windows, `symlink()` needs either Developer Mode or
 * `SeCreateSymbolicLinkPrivilege`. That privilege lives on the process's
 * security token, not on any one directory: it cannot change between calls
 * within a single run, so probing it once and reusing the result is a
 * memoization, not a shortcut that risks a stale answer. (A filesystem that
 * itself has no symlinks — some network shares, some FAT variants — answers
 * `ENOTSUP` and is read as the same "no"; every fixture in this repo creates
 * its roots under {@link normalizedTmpdir}, so it never arises here.)
 *
 * Because the answer is memoized for the whole process, what reads as "no"
 * matters more than usual: a `null` here silently `skip()`s every symlink test
 * for the rest of the run. So ONLY {@link SYMLINK_UNSUPPORTED_ERRNOS} is a
 * no. A tmpdir that is unwritable or missing, or a bug, is not an answer about
 * symlinks at all and stays loud rather than becoming a process-wide skip for
 * a reason nothing reported.
 *
 * Fixtures that depend on symlinks must ask rather than assume — and, having
 * asked, must SAY they skipped. A symlink case that silently no-ops reads as
 * a passing test for a property nobody exercised.
 *
 * @returns A {@link SymlinkCapability} token when this process can create
 *   symlinks, else `null`. Route the `null` case through vitest's `skip()`
 *   rather than a plain `return`, so the skip is visible in the report.
 */
export function symlinkCapability(): SymlinkCapability | null {
  if (cachedCapability === undefined) {
    const probe = safePath.join(normalizedTmpdir(), `.vat-symlink-probe-${randomBytes(4).toString('hex')}`);
    try {
      symlinkSync('.', probe);
      cachedCapability = {} as SymlinkCapability;
    } catch (error) {
      if (!isSymlinkUnsupported(error)) throw error;
      cachedCapability = null;
    }
    if (cachedCapability !== null) {
      // Best-effort: the capability answer comes from creation succeeding, not
      // from cleanup — a probe left behind by a failed rmSync (e.g. a transient
      // lock on the freshly-created reparse point) must not flip a real "yes"
      // into a memoized, process-wide "no". Only the filesystem refusing the
      // delete is that case; a bug is not, and stays loud.
      try {
        rmSync(probe, { force: true });
      } catch (error) {
        if (!isFilesystemAccessError(error)) throw error;
      }
    }
  }
  return cachedCapability;
}

/**
 * Create a symlink — the one sanctioned call site for `fs.symlinkSync` in
 * test code. Requires a {@link SymlinkCapability}, which only
 * {@link symlinkCapability} can mint, so a test cannot reach the real
 * syscall without first proving (or explicitly bypassing via `skip()`) that
 * this host supports it.
 *
 * @param _cap - Proof from {@link symlinkCapability} that this host can create symlinks
 * @param target - The existing path the new link should point at
 * @param path - Where to create the link
 * @param type - Windows-only link-type hint (`'file'` \| `'dir'` \| `'junction'`); ignored on POSIX
 */
export function createSymlink(
  _cap: SymlinkCapability,
  target: string,
  path: string,
  type?: 'dir' | 'file' | 'junction',
): void {
  symlinkSync(target, path, type);
}

/**
 * The async counterpart of {@link createSymlink}, for fixtures already using
 * `node:fs/promises`. Same capability requirement, same reasoning.
 *
 * @param _cap - Proof from {@link symlinkCapability} that this host can create symlinks
 * @param target - The existing path the new link should point at
 * @param path - Where to create the link
 * @param type - Windows-only link-type hint (`'file'` \| `'dir'` \| `'junction'`); ignored on POSIX
 */
export async function createSymlinkAsync(
  _cap: SymlinkCapability,
  target: string,
  path: string,
  type?: 'dir' | 'file' | 'junction',
): Promise<void> {
  await fs.symlink(target, path, type);
}

/**
 * The variables git exports into a hook, which a fixture must clear before it
 * can fabricate its own.
 *
 * These are the ones git sets *for* you. Deliberately **not** the operator's own
 * `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`/`GLOBAL`/`SYSTEM` channel — a test may be
 * using that on purpose to point a clone at a local path, and clearing it sends
 * the clone to the network instead.
 */
export const INHERITED_GIT_ENV = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_INDEX_VERSION',
  'GIT_NAMESPACE',
  'GIT_NOTES_REF',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_WORK_TREE',
] as const;

/**
 * Remove every inherited git redirection from `process.env`, and hand back the
 * undo.
 *
 * A test that fabricates a hook environment has to start from a known-clean one,
 * or it inherits whatever the *outer* runner exported and can no longer tell its
 * own fixture apart from the ambient state — it then passes or fails for reasons
 * it never set up. Restoring afterwards matters just as much: these are
 * process-global, so a test that leaks `GIT_DIR` silently redirects every later
 * test sharing the worker.
 *
 * ⚠️ **The key list is restated here on purpose, not by oversight.** Deriving it
 * from `@vibe-validate/git`'s `stripGitEnv()` would be tidier, and it is exactly
 * what this function did for one revision — but this module is the `./testing`
 * subpath, which `subpath-purity.test.ts` pins as reaching **no third-party
 * package at all** so it stays importable with zero dependencies installed. One
 * import cost that property. The drift risk the derivation was avoiding is
 * handled instead by {@link "../test/test-helpers-git-env.test".default}, which
 * asserts this list equals what the shipped scrub removes.
 *
 * @returns A function restoring every variable to its prior value, putting back
 *   "was not set" as unset rather than as an empty string
 *
 * @example
 * ```typescript
 * let restoreGitEnv: () => void;
 * beforeEach(() => { restoreGitEnv = detachGitEnv(); });
 * afterEach(() => { restoreGitEnv(); });
 * ```
 */
export function detachGitEnv(): () => void {
  const saved = new Map<string, string | undefined>();

  const forget = (name: string): void => {
    saved.set(name, process.env[name]);
    delete process.env[name];
  };

  for (const name of INHERITED_GIT_ENV) {
    forget(name);
  }

  return () => {
    for (const [name, value] of saved) {
      // Deleted first so an absent variable is restored as absent: assigning
      // `undefined` would leave the literal string 'undefined' behind.
      delete process.env[name];
      if (value !== undefined) process.env[name] = value;
    }
  };
}


/**
 * The errno-shaped error a refused `fs` call throws: a message, the `code`,
 * and the `syscall`, exactly as Node shapes one.
 */
export function errnoError(code: string, syscall: string, target: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: refused, ${syscall} '${target}'`), { code, syscall });
}

/** The sync `node:fs` calls a refusal can be injected into. */
export type RefusableSyncFsMethod =
  | 'readdirSync'
  | 'readFileSync'
  | 'statSync'
  | 'lstatSync'
  | 'realpathSync'
  | 'renameSync'
  | 'rmSync'
  | 'unlinkSync';

/** The `node:fs/promises` calls a refusal can be injected into. */
export type RefusableAsyncFsMethod = 'readdir' | 'readFile' | 'stat' | 'lstat' | 'access';

/**
 * Assign `fn` over `module[method]` and republish the builtin's ESM bindings.
 *
 * Assigning on the CJS object alone reaches ONLY a `import fs from 'node:fs'`
 * caller — a named or namespace import reads the builtin's ESM bindings, which
 * Node snapshots at import time. `syncBuiltinESMExports()` after each
 * assignment republishes the patch (and the restore) to every import style;
 * measured under vitest: without it, a spy on a named-import caller attached
 * and counted zero, which reads exactly like "this function performs no I/O".
 */
function republish(module: object, method: string, fn: unknown): void {
  (module as Record<string, unknown>)[method] = fn;
  syncBuiltinESMExports();
}

/**
 * Make `fs[method]` throw `code` for exactly `targetPath` until the returned
 * restore is called; every other path, and every other method, stays real.
 *
 * A patch rather than a `chmod`: `chmod` reaches one errno (`EACCES`), only
 * where POSIX modes bind, and not as root — and the property under test is
 * "any refusal that is not an absence", so `EACCES`, `ELOOP`, `EMFILE` must all
 * be reachable. What a walk under test meets is ONE refused call inside an
 * otherwise ordinary tree; a walk that gave up entirely would pass a test where
 * everything was refused.
 *
 * Lives in the shipped helpers because consumers in five packages each need to
 * refuse a call, and the duplication gate refuses five copies.
 */
export function refuseSyncFs(method: RefusableSyncFsMethod, targetPath: string, code: string): () => void {
  const original = nodeFs[method] as (...args: unknown[]) => unknown;
  const refused = toForwardSlash(targetPath);
  republish(nodeFs, method, (target: unknown, ...rest: unknown[]): unknown => {
    if (toForwardSlash(String(target)) === refused) throw errnoError(code, method, String(target));
    return original(target, ...rest);
  });
  return () => republish(nodeFs, method, original);
}

/**
 * `fs/promises[method]` rejects with `code` for exactly `targetPath` until the
 * returned restore is called; every other path, and every other method, is real.
 */
export function refuseAsyncFs(method: RefusableAsyncFsMethod, targetPath: string, code: string): () => void {
  const original = (fs[method] as (...args: unknown[]) => Promise<unknown>).bind(fs);
  const refused = toForwardSlash(targetPath);
  republish(fs, method, async (target: unknown, ...rest: unknown[]): Promise<unknown> => {
    if (toForwardSlash(String(target)) === refused) throw errnoError(code, method, String(target));
    return original(target, ...rest);
  });
  return () => republish(fs, method, original);
}

/**
 * Run `body` while `fs[method]` throws `code` for exactly `targetPath`; the
 * patch is lifted however `body` exits. See {@link refuseSyncFs}.
 */
export async function withSyncFsRefused<T>(
  method: RefusableSyncFsMethod,
  targetPath: string,
  code: string,
  body: () => T | Promise<T>,
): Promise<T> {
  const restore = refuseSyncFs(method, targetPath, code);
  try {
    return await body();
  } finally {
    restore();
  }
}

/**
 * Run `body` with `fs.readdirSync` of exactly `directory` throwing an error
 * carrying errno `code`. The listing case of {@link withSyncFsRefused}, named
 * because refusing a LISTING is the question the crawler's consumers ask.
 *
 * @param directory - Absolute path of the one directory to refuse
 * @param code - The errno to reject with
 * @param body - Runs while the refusal is in force; may be async
 * @returns Whatever `body` returned
 */
export async function withReaddirSyncRefused<T>(
  directory: string,
  code: string,
  body: () => T | Promise<T>,
): Promise<T> {
  return withSyncFsRefused('readdirSync', directory, code, body);
}
