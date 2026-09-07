/**
 * `isEntrypoint` tested in the package that OWNS it, against `src`.
 *
 * ## Why this file exists at all
 *
 * `isEntrypoint()` lives at `packages/utils/src/entrypoint.ts` and is published
 * on the `@vibe-agent-toolkit/utils/process` subpath. Its test did not move here
 * with it: the only coverage was `packages/dev-tools/test/common.test.ts`, which
 * reaches the function through `dist` via a re-export it does not own. Two
 * things followed, and both were true at once:
 *
 * 1. Replacing the realpath half of `isEntrypoint` with `return false` left the
 *    entire utils suite GREEN. A published export of this package had no guard
 *    at all inside this package.
 * 2. A dev-tools refactor that stops re-exporting the symbol — an ordinary
 *    cleanup, nothing suspicious about it — would have deleted the only test
 *    standing over that behaviour, with every suite still green.
 *
 * So the import below is `../src/entrypoint.js` and not the package name: a test
 * that reaches its subject through `dist` proves whatever `dist` happened to
 * hold, which may be an older build.
 *
 * ## What the cases pin
 *
 * `isEntrypoint` answers in two stages, and the SECOND is the silently deletable
 * one:
 *
 * - a resolved string compare, which decides every ordinary invocation, and
 * - a realpath pass, which is the entire reason the helper exists. A
 *   `node_modules/.bin` entry is a SYMLINK, so `process.argv[1]` is the link
 *   while `import.meta.url` is the resolved target. The two strings differ, and
 *   a guard that stops at the compare answers `false` for the script it was
 *   asked to run — the process then exits 0 having done nothing.
 *
 * Every symlink case below is paired with a negative control resolving to a
 * DIFFERENT real file, so a bare `return true` fails as loudly as `return
 * false`. The linked-directory pair goes further and gives the impostor the same
 * BASENAME, so passing requires resolving the link rather than comparing tails.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isEntrypoint } from '../src/entrypoint.js';
import { safePath } from '../src/path-core.js';
import { mkdirSyncReal, normalizedTmpdir } from '../src/path-utils.js';
import {
  createSymlink,
  removeScratchDir,
  type SymlinkCapability,
  symlinkCapability,
} from '../src/test-helpers.js';

/** This module's own location, in both spaces the function deals in. */
const THIS_URL = import.meta.url;
const THIS_PATH = safePath.resolve(fileURLToPath(THIS_URL));
const THIS_DIR = safePath.resolve(fileURLToPath(new URL('.', THIS_URL)));
const THIS_BASENAME = 'entrypoint.test.ts';

/** Write a real file so a negative control is a file, not a dangling name. */
function writeRealFile(at: string, what: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path built here from this suite's own temp root; no input reaches it
  writeFileSync(at, `// ${what}\n`);
  return at;
}

describe('isEntrypoint', () => {
  let scratch = '';

  beforeAll(() => {
    scratch = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-utils-entrypoint-'));
  });

  afterAll(async () => {
    await removeScratchDir(scratch);
  });

  describe('the resolved compare', () => {
    it('is true for the module path itself', () => {
      expect(isEntrypoint(THIS_URL, THIS_PATH)).toBe(true);
    });

    it('is true for a RELATIVE spelling of the same path', () => {
      // `process.argv[1]` is whatever the shell handed over, and `node test/x.ts`
      // hands over a relative path. Same file, a raw `===` would reject it.
      const relative = safePath.relative(process.cwd(), THIS_PATH);
      expect(relative).not.toBe(THIS_PATH);
      expect(isEntrypoint(THIS_URL, relative)).toBe(true);
    });

    it('is false for a different real file', () => {
      const other = writeRealFile(safePath.join(scratch, 'not-this-module.ts'), 'a real file, not this one');
      expect(isEntrypoint(THIS_URL, other)).toBe(false);
    });
  });

  describe('an argv[1] that names nothing', () => {
    it('is false when there is no argv[1] at all', () => {
      // `node -e` / `node --input-type=module` both leave it undefined. Read it
      // out of an argv-shaped array rather than writing `undefined` at the call
      // site, so the absent element is what the case is made of.
      const argvWithNoScript = ['/usr/bin/node'];
      expect(isEntrypoint(THIS_URL, argvWithNoScript[1])).toBe(false);
    });

    it('is false for an EMPTY argv[1] — even when the cwd IS the module URL', () => {
      // `resolve('')` is the cwd, so an empty argv[1] can MATCH by accident
      // rather than by invocation. Asserting that only against this test file
      // proves nothing: a file path is never a directory, so the compare fails
      // for its own reasons and the guard could be deleted with the suite still
      // green (measured). Pointing the module URL at the cwd itself is the one
      // shape where the guard is the only thing standing between `''` and a
      // `true` answer, so that is what this pins.
      const cwdUrl = pathToFileURL(process.cwd()).href;
      expect(isEntrypoint(cwdUrl, '')).toBe(false);
      expect(isEntrypoint(THIS_URL, '')).toBe(false);
    });
  });

  /**
   * The realpath half — the branch that can be replaced with `return false`
   * today without any other test in this package noticing.
   */
  describe('through a symlink, which is what a .bin shim is', () => {
    /** A link under the scratch root, named for the case rather than the target. */
    const linkNamed = (
      cap: SymlinkCapability,
      target: string,
      name: string,
      kind: 'dir' | 'file',
    ): string => {
      const created = safePath.join(scratch, name);
      createSymlink(cap, target, created, kind);
      return created;
    };

    it('is true when argv[1] is a FILE link resolving to this module', ({ skip }) => {
      const cap = symlinkCapability() ?? skip();

      const shim = linkNamed(cap, THIS_PATH, 'file-shim.ts', 'file');
      expect(shim).not.toBe(THIS_PATH);
      expect(isEntrypoint(THIS_URL, shim)).toBe(true);
    });

    it('is false when a FILE link resolves to a different module', ({ skip }) => {
      const cap = symlinkCapability() ?? skip();

      const decoy = writeRealFile(safePath.join(scratch, 'decoy.ts'), 'the negative control');
      const shim = linkNamed(cap, decoy, 'wrong-file-shim.ts', 'file');
      expect(isEntrypoint(THIS_URL, shim)).toBe(false);
    });

    it('is true when argv[1] reaches this module through a linked DIRECTORY', ({ skip }) => {
      const cap = symlinkCapability() ?? skip();

      // The other shim shape: the leaf name is real, an ancestor is the link.
      const shim = linkNamed(cap, THIS_DIR, 'linked-dir', 'dir');
      const through = safePath.join(shim, THIS_BASENAME);
      expect(through).not.toBe(THIS_PATH);
      expect(isEntrypoint(THIS_URL, through)).toBe(true);
    });

    it('is false when a linked DIRECTORY holds a different file of the SAME name', ({ skip }) => {
      const cap = symlinkCapability() ?? skip();

      const impostorDir = mkdirSyncReal(safePath.join(scratch, 'impostor'));
      writeRealFile(safePath.join(impostorDir, THIS_BASENAME), 'same basename, different file');
      const shim = linkNamed(cap, impostorDir, 'linked-impostor-dir', 'dir');
      expect(isEntrypoint(THIS_URL, safePath.join(shim, THIS_BASENAME))).toBe(false);
    });

    it('is true when the MODULE URL is the linked side and argv[1] is real', ({ skip }) => {
      const cap = symlinkCapability() ?? skip();

      // The mirror image: the module was loaded through the link, so the
      // symlinked path is on the `import.meta.url` side. The realpath pass has
      // to normalize BOTH operands, not just argv[1].
      const shim = linkNamed(cap, THIS_PATH, 'mirrored-shim.ts', 'file');
      expect(isEntrypoint(pathToFileURL(shim).href, THIS_PATH)).toBe(true);
    });
  });
});
