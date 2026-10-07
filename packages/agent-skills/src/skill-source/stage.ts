import { chmodSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';

import { forEachInOrder, mkdirSyncReal, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import { proveReadable, withFsAttribution } from '../fs-attribution.js';

import { readingSkillSource, SkillSourceUnreadableError } from './source-unreadable.js';
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
  await withFsAttribution(`Staging ${srcDir}`, 'output', () => ensureOwned0700Dir(ctx.stagingRoot, currentUid), 'staged');

  const dest = safePath.join(ctx.stagingRoot, key);
  assertOwnedIfExists(dest, currentUid);

  await withFsAttribution(`Staging ${srcDir}`, 'output', () => mkdir(dest, { recursive: true }), 'staged');
  await copyTreeNoSymlinks(srcDir, dest);
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

/**
 * Recursively copy `src` into `dest`, refusing any symlinked entry. A write the OS
 * refuses (a full disk, an unwritable staging root) is coded as the run's output
 * (`SKILL_PACKAGING_OUTPUT_FAILED`, `RUN_INCOMPLETE`); a source entry it will not
 * read or list, and a symlink, are the input's (`SKILL_SOURCE_UNREADABLE`, `INPUT_UNREADABLE`).
 */
async function copyTreeNoSymlinks(src: string, dest: string): Promise<void> {
  const entries = await readingSkillSource(src, () => readdirSync(src, { withFileTypes: true }));
  // In order: mkdir before recursing, a symlink refused before anything after it is copied.
  await forEachInOrder(entries, async (entry) => {
    const srcPath = safePath.join(src, entry.name);
    const destPath = safePath.join(dest, entry.name);
    // lstat (not stat) so a symlink is detected, never followed.
    const st = await readingSkillSource(srcPath, () => lstatSync(srcPath));
    if (st.isSymbolicLink()) {
      // The operator's input refused on purpose — coded, so it is never published as a VAT defect.
      throw new SkillSourceUnreadableError(
        `Refusing to stage symlink '${srcPath}': staging never traverses symlinked components (§7). `
          + 'Replace the link with the file or directory it points at.',
      );
    }
    if (st.isDirectory()) {
      await withFsAttribution(`Staging ${srcPath}`, 'output', () => mkdir(destPath, { recursive: true }), 'staged');
      await copyTreeNoSymlinks(srcPath, destPath);
    } else if (st.isFile()) {
      // Read side first, coded as the input: an unreadable source is never the staging output's failure.
      await readingSkillSource(srcPath, () => proveReadable(srcPath));
      await withFsAttribution(`Staging ${srcPath}`, 'output', () => copyFile(srcPath, destPath), 'staged');
    }
  });
}
