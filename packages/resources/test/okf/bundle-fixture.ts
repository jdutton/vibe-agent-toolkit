/**
 * A throwaway OKF bundle on disk, written from a literal.
 *
 * `createTempCorpus` from `@vibe-agent-toolkit/utils/testing` cannot serve here:
 * it writes every fixture name directly under the root, and an OKF bundle's
 * whole point is the **tree** — reserved filenames have meaning "at any level"
 * (§3.1) and `/`-absolute links resolve against the bundle root from an
 * arbitrary depth. So this helper does the one thing that one does not:
 * `mkdir -p` each fixture's parent before writing it.
 *
 * Every OKF suite plants through this, so the `mkdtemp` + recursive-teardown
 * pair and its `security/detect-non-literal-fs-filename` justification live in
 * exactly one place.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import {
  createSymlink,
  isAbsolutePath,
  mkdirSyncReal,
  normalizedTmpdir,
  safePath,
  symlinkCapability,
} from '@vibe-agent-toolkit/utils';
import { afterEach } from 'vitest';

/** Bundle-relative fixture path → file content, written verbatim as UTF-8. */
export type BundleLiteral = Readonly<Record<string, string>>;

const planted: string[] = [];

afterEach(() => {
  for (const root of planted.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Plant a bundle tree and return its absolute root.
 *
 * The tree is removed by this module's own `afterEach`, so a suite plants a
 * different literal per test without owning any teardown of its own.
 *
 * @param files - Bundle-relative path (forward slashes) to file content
 * @returns Absolute, forward-slashed bundle root
 */
export function plantOkfBundle(files: BundleLiteral): string {
  const root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-okf-'));
  planted.push(root);

  for (const [name, content] of Object.entries(files)) {
    const target = safePath.joinUnderRoot(root, name);
    mkdirSyncReal(safePath.join(target, '..'), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- same literal-derived path, same enforced root
    writeFileSync(target, content, 'utf8');
  }

  return root;
}

/** A minimal conformant concept document, with a body marker naming its type. */
export function conceptDoc(type: string, body = ''): string {
  return `---\ntype: ${type}\n---\n\n# ${type}\n\n${body}\n`;
}

/**
 * Concept `type` values and file bodies the suites reuse.
 *
 * Named here rather than repeated as literals: `sonarjs/no-duplicate-string`
 * fires at three occurrences, and the shared home also keeps the two suites
 * describing the same fixture with the same words.
 */
export const TABLE_TYPE = 'BigQuery Table';
export const REFERENCE_TYPE = 'Reference';
export const NO_FRONTMATTER = '# No frontmatter\n';

/**
 * One visible name, `café`, in the two Unicode normalization forms — as a
 * DIRECTORY component and as a filename.
 *
 * The directory pair is not decoration: a link's normalization form is a
 * property of every path component, and a judge that only inspected the last
 * one reported nothing at all for `café/guide.md` written NFD against an NFC
 * directory on disk.
 *
 * Built with `String.fromCodePoint` rather than typed as `\u` escapes: an
 * escape typed into a source file is normalized into real bytes on the way in,
 * which makes the two constants indistinguishable in review — and this pair's
 * whole point is that they LOOK identical and are different bytes.
 *
 * NFD is the on-disk spelling and NFC the link spelling, because that is the
 * direction that breaks: the bundle is authored on a Mac, where both forms open,
 * and 404s on the byte-exact filesystem every consumer unpacks it onto.
 */
export const NFD_CAFE_DIR = `caf${String.fromCodePoint(0x65, 0x301)}`;
export const NFC_CAFE_DIR = `caf${String.fromCodePoint(0xe9)}`;
export const NFD_CAFE_DOC = `${NFD_CAFE_DIR}.md`;
export const NFC_CAFE_DOC = `${NFC_CAFE_DIR}.md`;

/** The finding codes a report carries, in report order. */
export function codesOf(findings: ReadonlyArray<{ code: string }>): string[] {
  return findings.map((finding) => finding.code);
}

/**
 * Proof this host can create a symlink, minted once for the whole suite.
 *
 * `symlinkCapability()` is the repo's sanctioned probe and `createSymlink` the
 * one call site it unlocks — a hand-rolled `symlinkSync` here would be a second,
 * differently-behaved answer to a question one function already owns (and the
 * `local/no-bare-symlink-in-tests` rule exists to stop exactly that).
 */
const SYMLINK_CAPABILITY = symlinkCapability();

/**
 * Whether this machine can create a symlink at all.
 *
 * Windows refuses without Developer Mode or an elevated shell, and a suite that
 * hard-failed there would be reporting the CI host's privileges rather than
 * VAT's behaviour. Route it through `it.skipIf` so the skip is visible in the
 * report — a symlink case that silently no-ops reads as a passing test for a
 * property nobody exercised.
 */
export const SYMLINKS_AVAILABLE: boolean = SYMLINK_CAPABILITY !== null;

/**
 * What a planted symlink points at, which is a Windows question.
 *
 * `symlinkSync` needs `SeCreateSymbolicLinkPrivilege` there — Developer Mode or
 * an elevated shell — which most CI agents do not hold. A *directory* link can
 * dodge that entirely as a junction, so the two kinds are not interchangeable
 * and the caller has to say which it means.
 */
export type SymlinkKind = 'file' | 'dir';

/** The `type` argument that costs no privilege for this kind on this platform. */
function symlinkType(kind: SymlinkKind): 'file' | 'dir' | 'junction' {
  return kind === 'dir' && process.platform === 'win32' ? 'junction' : kind;
}

/**
 * Plant a symlink inside an already-planted bundle.
 *
 * Separate from {@link plantOkfBundle}'s literal because a symlink is not
 * content: it is an entry whose `Dirent` answers `isFile()` with `false`, which
 * is precisely the fact the discovery suite is pinning.
 *
 * ⚠️ **The target is not required to exist, and is not required to be inside
 * the root.** It used to be resolved with `safePath.joinUnderRoot`, which meant
 * the fixture could express neither a DANGLING link nor one that ESCAPES the
 * bundle — the two cases that decide whether a `.md` entry travels with the
 * tarball at all. That is why the coherence defect between discovery and link
 * resolution had no test: the corpus could not state it. An absolute
 * `targetPath` is used verbatim; a relative one is still resolved under the
 * root, so the containment guarantee is only relaxed where a caller says so.
 *
 * @param root - Absolute bundle root returned by {@link plantOkfBundle}
 * @param linkPath - Bundle-relative path the link is created at
 * @param targetPath - Where the link points: bundle-relative, or absolute to
 *   point outside the bundle. Neither form has to exist
 * @param kind - Whether the target is a file or a directory
 * @throws If the platform refuses the link, naming the privilege that is missing
 */
export function plantSymlink(
  root: string,
  linkPath: string,
  targetPath: string,
  kind: SymlinkKind,
): void {
  if (SYMLINK_CAPABILITY === null) {
    throw new Error(
      `Cannot plant the ${kind} symlink "${linkPath}": this host does not grant symlink ` +
        `creation (on Windows that is SeCreateSymbolicLinkPrivilege — Developer Mode or an ` +
        `elevated shell). Gate the test on SYMLINKS_AVAILABLE so the skip is visible in the report.`,
    );
  }

  const link = safePath.joinUnderRoot(root, linkPath);
  mkdirSyncReal(safePath.join(link, '..'), { recursive: true });
  const target = isAbsolutePath(targetPath)
    ? targetPath
    : safePath.joinUnderRoot(root, targetPath);
  createSymlink(SYMLINK_CAPABILITY, target, link, symlinkType(kind));
}
