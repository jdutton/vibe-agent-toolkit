import { chmodSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';

import { mkdirSyncReal, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import type { ResolveSkillSourceContext } from './types.js';

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
  ensureOwned0700Dir(ctx.stagingRoot, currentUid);

  const dest = safePath.join(ctx.stagingRoot, key);
  assertOwnedIfExists(dest, currentUid);

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- dest under our 0700 staging root
  await mkdir(dest, { recursive: true });
  await copyTreeNoSymlinks(srcDir, dest);
  return toForwardSlash(dest);
}

/** Create `dir` (and parents) 0700 if absent; if present, require current-uid ownership. */
function ensureOwned0700Dir(dir: string, currentUid: number): void {
  mkdirSyncReal(dir, { recursive: true, mode: 0o700 });
  assertOwnedIfExists(dir, currentUid);
  // Re-enforce 0700 in case the dir already existed with looser permissions.
  // assertOwnedIfExists above confirms we own it (if it exists), so chmod is safe.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own staging root confirmed owned above
  chmodSync(dir, 0o700);
}

function assertOwnedIfExists(dir: string, currentUid: number): void {
  let st;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- ownership probe on our own staging path
    st = statSync(dir);
  } catch (err) {
    // Only an absent path is safe to ignore. A different error (e.g. EACCES on
    // an unreadable path) must NOT be silently treated as "absent/safe".
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (currentUid >= 0 && st.uid !== currentUid) {
    throw new Error(
      `Refusing to stage into '${dir}': directory ownership (uid ${st.uid}) ` +
        `does not match the current user (uid ${currentUid}). Possible shared-tmp attack.`,
    );
  }
}

/** Recursively copy `src` into `dest`, refusing any symlinked entry. */
async function copyTreeNoSymlinks(src: string, dest: string): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- src is a resolved source dir
  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = safePath.join(src, entry.name);
    const destPath = safePath.join(dest, entry.name);
    // lstat (not stat) so a symlink is detected, never followed.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- srcPath under caller-provided src
    const st = lstatSync(srcPath);
    if (st.isSymbolicLink()) {
      throw new Error(
        `Refusing to stage symlink '${srcPath}': staging never traverses symlinked components (§7).`,
      );
    }
    if (st.isDirectory()) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- destPath under our 0700 staging root
      await mkdir(destPath, { recursive: true });
      await copyTreeNoSymlinks(srcPath, destPath);
    } else if (st.isFile()) {
      await copyFile(srcPath, destPath);
    }
  }
}
