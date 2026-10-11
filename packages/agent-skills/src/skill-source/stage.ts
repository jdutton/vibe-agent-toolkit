import { chmodSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';

import {
  forEachInOrder,
  type FsBoundary,
  fsBoundary,
  isPathAbsentError,
  mkdirSyncReal,
  readRegularFile,
  safePath,
  toForwardSlash,
  VatError,
  withFsFault,
} from '@vibe-agent-toolkit/utils';

import type { ResolveSkillSourceContext } from './types.js';

/** The `VatError` code of a skill source staging refuses on purpose: a symlinked entry (§7). */
export const SKILL_SOURCE_UNREADABLE_CODE = 'SKILL_SOURCE_UNREADABLE';

/**
 * A skill source staging refuses on purpose — a symlinked entry, which staging never
 * traverses. Reason `preflight`: the operator replaces the link. A source the OS will
 * not read is a classified `source` fault (`FsFaultError`), not this.
 */
export class SkillSourceUnreadableError extends VatError {
  readonly reason = 'preflight' as const;
  constructor(message: string, options?: ErrorOptions) {
    super(SKILL_SOURCE_UNREADABLE_CODE, message, options);
  }
}

/** Test seam: lets unit tests simulate a foreign-owned dir without a second OS user. */
export interface StageOptions {
  /** Override the "current uid" used for the ownership check (test-only). */
  uidOverride?: number;
}

/**
 * Copy `srcDir` into `<ctx.stagingRoot>/<key>` and return the forward-slash
 * absolute staged path.
 *
 * §7 hardening: the staging root is created 0700; a pre-existing staging root
 * or key dir that is not owned by the current uid is rejected; symlinked path
 * components in the SOURCE tree are refused (never copied through).
 *
 * @param srcDir Absolute path to the resolved source directory.
 * @param ctx Resolution context (supplies stagingRoot).
 * @param key Content-addressed key (already sanitized — caller passes a hash or hex).
 * @returns Forward-slash absolute staged directory path.
 */
export async function stageDirInto(
  srcDir: string,
  ctx: ResolveSkillSourceContext,
  key: string,
  opts: StageOptions = {},
): Promise<string> {
  const currentUid = opts.uidOverride ?? (process.getuid?.() ?? -1);
  // Role by PATH: the source tree is the operator's input; the staging root is VAT's scratch.
  const boundary = fsBoundary({ source: [srcDir], environment: [ctx.stagingRoot] }, { origin: 'content' });
  boundary.runSync(`create the staging root for ${srcDir}`, 'environment', () => ensureOwned0700Dir(ctx.stagingRoot, currentUid));

  const dest = safePath.join(ctx.stagingRoot, key);
  boundary.runSync(`examine the staged copy ${dest}`, 'environment', () => assertOwnedIfExists(dest, currentUid));

  await boundary.run(`stage ${srcDir}`, 'environment', () => mkdir(dest, { recursive: true }));
  await copyTreeNoSymlinks(srcDir, dest, boundary);
  return toForwardSlash(dest);
}

/** Create `dir` (and parents) 0700 if absent; if present, require current-uid ownership. */
function ensureOwned0700Dir(dir: string, currentUid: number): void {
  mkdirSyncReal(dir, { recursive: true, mode: 0o700 });
  assertOwnedIfExists(dir, currentUid);
  // Re-enforce 0700 in case the dir already existed with looser permissions.
  // assertOwnedIfExists above confirms we own it (if it exists), so chmod is safe.
  chmodSync(dir, 0o700);
}

function assertOwnedIfExists(dir: string, currentUid: number): void {
  let st;
  try {
    st = statSync(dir);
  } catch (err) {
    // Only an absent path is safe to ignore. A different error (e.g. EACCES on
    // an unreadable path) must NOT be silently treated as "absent/safe".
    if (isPathAbsentError(err)) return;
    throw err;
  }
  if (currentUid >= 0 && st.uid !== currentUid) {
    throw new Error(
      `Refusing to stage into '${dir}': directory ownership (uid ${st.uid}) ` +
        `does not match the current user (uid ${currentUid}). Possible shared-tmp attack.`,
    );
  }
}

/**
 * Recursively copy `src` into `dest`, refusing any symlinked entry. Every fault is
 * classified by the path the OS named: a write the OS refuses under the staging root
 * (a full disk, an unwritable staging root) is the environment's (`RUN_INCOMPLETE`);
 * a source entry it will not read or list is the input's. A symlink is refused on
 * purpose ({@link SkillSourceUnreadableError}, `INPUT_UNREADABLE`).
 */
async function copyTreeNoSymlinks(src: string, dest: string, boundary: FsBoundary): Promise<void> {
  const entries = boundary.runSync(`list ${src}`, 'source', () => readdirSync(src, { withFileTypes: true }));
  // In order: mkdir before recursing, a symlink refused before anything after it is copied.
  await forEachInOrder(entries, async (entry) => {
    const srcPath = safePath.join(src, entry.name);
    const destPath = safePath.join(dest, entry.name);
    // lstat (not stat) so a symlink is detected, never followed.
    const st = boundary.runSync(`examine ${srcPath}`, 'source', () => lstatSync(srcPath));
    if (st.isSymbolicLink()) {
      // The operator's input refused on purpose — coded, so it is never published as a VAT defect.
      throw new SkillSourceUnreadableError(
        `Refusing to stage symlink '${srcPath}': staging never traverses symlinked components (§7). `
          + 'Replace the link with the file or directory it points at.',
      );
    }
    if (st.isDirectory()) {
      await boundary.run(`stage ${srcPath}`, 'environment', () => mkdir(destPath, { recursive: true }));
      await copyTreeNoSymlinks(srcPath, destPath, boundary);
    } else if (st.isFile()) {
      // Read side first, whole, through a handle judged by `fstat` (a named pipe is refused,
      // never waited on): an unreadable source is never the staging copy's failure. The
      // write is then the environment's by declaration, its mode the source's, as a copy keeps it.
      // Buffered whole, not streamed: memory follows the largest file, which for a skill is small.
      const bytes = await boundary.run(`read ${srcPath}`, 'source', () => readRegularFile(srcPath));
      await withFsFault({ side: 'environment', action: `stage ${srcPath}` }, async () => {
        await writeFile(destPath, bytes);
        await chmod(destPath, st.mode & 0o7777);
      });
    }
  });
}
