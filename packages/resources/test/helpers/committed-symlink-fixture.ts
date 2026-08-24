/**
 * Plants a temp git repo containing REAL on-disk symlinks, committed — the
 * mechanical half of `projection-git-extent-symlink.test.ts` and
 * `projection-filesystem-extent-symlink.test.ts`.
 *
 * ## Only the mechanics live here
 *
 * Those two suites ask opposite questions of the same shape of tree (does the
 * git extent keep a link's identity distinct? does the filesystem extent
 * realize a link's own path at all?), and each is trustworthy only because of
 * the controls it states BEFORE its claim — the mode-`120000` staging check,
 * the shared-blob-OID check, the positive-control regular file. **None of those
 * assertions belong here.** A helper that asserted its own fixture came out
 * right would hide the one thing those suites exist to prove is checked, and
 * would be invisible to a reader of either file (see *"assertion helpers"* in
 * `docs/writing-tests.md`: return the value, let the caller assert).
 *
 * So this module does `mkdtemp` → `git init` → `mkdir` → write → `createSymlink`
 * → `git add` → `git commit`, and then hands back the root plus the RAW
 * `git ls-files -s` output. Every suite re-derives and asserts its own controls
 * from that string.
 *
 * ## Capability gating is preserved, not bypassed
 *
 * {@link plantCommittedSymlinkFixture} calls `symlinkCapability()` itself and
 * throws when it is null, so nothing here runs at import time and an ungated
 * caller gets a message naming the fix rather than a bare `EPERM` on a host it
 * doesn't control. Both callers still gate their `describe` with
 * `describe.skipIf(!symlinkCapability())`, which is what keeps a skipped
 * symlink suite VISIBLE in the report; the throw is the backstop for a suite
 * that forgets.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- controlled temp fixture tree */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import {
  createSymlink,
  mkdirSyncReal,
  normalizedTmpdir,
  runGitOrThrow,
  safePath,
  symlinkCapability,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';

/**
 * Git's mode for a symlink in `git ls-files -s`. Its blob holds the TARGET
 * STRING, not file bytes — which is why two links to one target are
 * byte-identical and collide on a content key.
 */
export const GIT_MODE_SYMLINK = '120000';

/** Identity and authorship for the fixture commit, so a host's own config cannot fail it. */
const COMMIT_CONFIG = [
  '-c',
  'user.name=VAT Fixture',
  '-c',
  'user.email=fixture@example.invalid',
  '-c',
  'commit.gpgsign=false',
];

/** One symlink to plant and commit. */
export interface SymlinkPlan {
  /** Root-relative, forward-slashed path of the link itself. */
  readonly path: string;
  /** The link's target text, spelled relative to the link's OWN directory. */
  readonly target: string;
}

/** What to plant in the fixture repo. */
export interface CommittedSymlinkFixtureSpec {
  /** `mkdtemp` basename prefix, so a leaked temp dir names the suite that made it. */
  readonly prefix: string;
  /** Root-relative, forward-slashed paths of regular files to write and commit. */
  readonly files: readonly string[];
  /** The symlinks to create and commit, after {@link CommittedSymlinkFixtureSpec.files} exist. */
  readonly links: readonly SymlinkPlan[];
}

/** A planted fixture: where it is, and what git recorded for it. */
export interface CommittedSymlinkFixture {
  /** Absolute, forward-slashed repo root. */
  readonly root: string;
  /**
   * Raw `git ls-files -s` output for the committed index.
   *
   * Returned UNPARSED on purpose: each suite's staging control is its own, and
   * a helper that pre-digested this into "the symlink entries" would be the
   * assertion those suites must make for themselves.
   */
  readonly lsFilesStaged: string;
}

/**
 * The `git ls-files -s` lines git recorded with a symlink's mode.
 *
 * A splitter, not a checker — it makes no claim about how many there are or
 * which paths they name. Callers assert the count, the paths and the blob OIDs
 * themselves, and those call-site assertions are what keep this armed.
 *
 * @param lsFilesStaged - Raw output from `git ls-files -s`
 * @returns Every line whose mode is {@link GIT_MODE_SYMLINK}, in git's order
 */
export function symlinkIndexLines(lsFilesStaged: string): string[] {
  return lsFilesStaged.split('\n').filter((line) => line.startsWith(GIT_MODE_SYMLINK));
}

/**
 * Create a temp git repo with the requested files and symlinks, committed.
 *
 * File content is derived from each path (`# <path>`) so no two fixture files
 * are byte-identical by accident — a content-key collision the suite never
 * asked for would be indistinguishable from the identity collapse these suites
 * are looking for.
 *
 * @param spec - What to plant
 * @returns The repo root and the raw staged index listing
 * @throws {Error} When this process cannot create symlinks — gate the suite on
 *   `describe.skipIf(!symlinkCapability())` so it reports as skipped instead
 */
export function plantCommittedSymlinkFixture(
  spec: CommittedSymlinkFixtureSpec,
): CommittedSymlinkFixture {
  const cap = symlinkCapability();
  if (!cap) {
    throw new Error(
      'plantCommittedSymlinkFixture: this host cannot create symlinks — gate the suite with describe.skipIf(!symlinkCapability())',
    );
  }

  const root = toForwardSlash(mkdtempSync(safePath.join(normalizedTmpdir(), spec.prefix)));
  runGitOrThrow(['init'], { cwd: root });

  for (const file of spec.files) {
    mkdirSyncReal(safePath.join(root, file, '..'), { recursive: true });
    writeFileSync(safePath.join(root, file), `# ${file}\n`);
  }

  for (const link of spec.links) {
    mkdirSyncReal(safePath.join(root, link.path, '..'), { recursive: true });
    createSymlink(cap, link.target, safePath.join(root, link.path));
  }

  runGitOrThrow(['add', ...spec.files, ...spec.links.map((link) => link.path)], { cwd: root });
  runGitOrThrow([...COMMIT_CONFIG, 'commit', '-m', 'fixture'], { cwd: root });

  return { root, lsFilesStaged: runGitOrThrow(['ls-files', '-s'], { cwd: root }) };
}

/**
 * Best-effort teardown for a root from {@link plantCommittedSymlinkFixture}.
 *
 * Tolerates an unset root so an `afterAll` still runs cleanly when the
 * `beforeAll` that would have set it threw.
 *
 * @param root - The fixture root, or an empty/undefined value if setup failed
 */
export function removeCommittedSymlinkFixture(root: string | undefined): void {
  if (root) {
    rmSync(root, { recursive: true, force: true });
  }
}
