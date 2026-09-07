/**
 * Cross-link resolution inside a bundle (§6.1).
 *
 * ## Why the leading slash is the whole story
 *
 * OKF's recommended link form is `/tables/customers.md`, and the `/` means the
 * **bundle root**, not the filesystem root. That is exactly the contract
 * `resolveLocalHref` already implements for VAT's project root, so this module
 * calls it with the bundle root in that slot rather than growing a second path
 * resolver. Fragment stripping, percent-decoding and the escapes-the-root
 * verdict all come with it — three behaviours a parallel implementation would
 * have had to re-derive, and would have derived slightly differently.
 *
 * ## Why an escape is its own finding
 *
 * A bundle is the unit of distribution (§2). A link resolving above the root
 * may well point at a real file on the author's disk, and will still be broken
 * for everyone who receives the tarball — so reporting it as "target missing"
 * would send the author looking for a file that is right there.
 *
 * ## ⛔ Why existence is NOT `stat()`
 *
 * `stat()` answers on the machine VAT is running on. The publisher's machine is
 * routinely a Mac, where the filesystem reconciles both letter case and Unicode
 * normalization form; the machine the tarball is unpacked onto routinely is not.
 * A bare `stat()` therefore certifies a bundle whose links 404 for every
 * consumer — and it is the *worst* place in VAT for that gap, because §2 makes
 * the bundle the unit of distribution: "it resolves on the author's laptop" is
 * not merely a weak oracle here, it is the wrong question.
 *
 * ## ⛔ Why EVERY path component is judged, not just the basename
 *
 * 🪤 The first version of that answer classified `basename(resolvedPath)`
 * against a listing of `dirname(resolvedPath)` — which handed every DIRECTORY
 * component straight back to the host filesystem's folding, the exact oracle
 * the paragraph above rejects. `readdir('<root>/Docs')` succeeds on macOS when
 * the directory is really `docs`, the basename then matched byte for byte, and
 * VAT reported nothing; the same bundle on a case-sensitive volume produced the
 * finding. Measured on one fixture: 4 findings against 5. The Unicode half was
 * silent the same way, and that one 404s on Linux.
 *
 * Worse than incomplete, the *remedy* was wrong: with two components misspelled
 * the message said `Spell the link "guide.md"`, and a publisher who wrote that
 * down still had a link that 404s. So {@link BundleDirectoryIndex.judge} walks
 * the path from the bundle root down, judges each component against the
 * directory that actually holds it, and reports the whole corrected path.
 *
 * ## ⛔ Why the listing is INDEXED rather than scanned
 *
 * The judge this replaced ran up to three linear `find()` scans over the parent
 * listing **per link**, folding each entry to NFC and lower-case on the way — so
 * the cost was O(links × entries-in-that-directory), and it was measured. 8,000
 * documents holding 80,000 broken links, end to end:
 *
 * | layout | before | after |
 * |---|---|---|
 * | one directory of 8,000 | 32.1 s | 14.9 s |
 * | eight directories of 1,000 | 20.1 s | 14.9 s |
 *
 * The width term is gone: the two layouts now cost the same, and what remains is
 * parsing 8,000 documents, which both arms pay. Verdicts are identical (80,000
 * findings in every cell).
 *
 * `DirectorySpellingIndex` lists each directory once and indexes it once, under
 * all three spellings the judge can ask for, so a lookup is a `Map.get`. Judging
 * every component (above) multiplies the number of lookups by the path depth,
 * which is exactly why it had to stop being a scan first.
 *
 * ⚠️ **Both of those defects were live in `vat resources validate` too**, which
 * is a shipped command rather than this unreleased one, so the machinery moved
 * to `@vibe-agent-toolkit/utils` and both lanes now share one implementation.
 * What is left here is the bundle-specific policy: which root, and which finding
 * code each verdict earns.
 *
 * ## ⛔ Why there is no is-it-a-directory check
 *
 * There was one, costing an `fs.stat` per resolved target, and nothing read the
 * answer except a `local_directory` link pointing at a regular file. VAT's own
 * `validateResolvedFile` dropped the equivalent check for exactly that reason.
 * Keeping a second, differently-behaved oracle in this lane would mean a link
 * VAT calls broken in one command and fine in the other.
 */

import {
  DirectorySpellingIndex,
  type FsLookupCache,
  type PathSpelling,
} from '@vibe-agent-toolkit/utils';

import type { ResourceLink } from '../types.js';
import { isWithinProject, resolveLocalHref, splitHrefAnchor } from '../utils.js';

import type { OkfFindingDraft } from './findings.js';

/**
 * Every directory inside one bundle root, listed once and indexed once.
 *
 * A {@link DirectorySpellingIndex} bound to one root: the machinery — the
 * three-way listing index, the component-by-component walk, and the refusal to
 * look above the root — lives in `@vibe-agent-toolkit/utils`, shared with
 * `vat resources validate`, which had both of the same defects. All this adds is
 * the bundle root, so no caller in this lane has to carry it to every call.
 *
 * ⛔ **The root is the BUNDLE root, and that is a correctness claim.** A bundle
 * is the unit of distribution (§2), so a verdict that depends on a directory
 * above the root is a verdict that changes when the tarball is unpacked
 * somewhere else. {@link DirectorySpellingIndex.judgePath} refuses to walk from
 * anywhere but here.
 */
export class BundleDirectoryIndex extends DirectorySpellingIndex {
  readonly #root: string;

  constructor(root: string, fsCache: FsLookupCache) {
    super(fsCache);
    this.#root = root;
  }

  /** The bundle root every lookup is confined to. */
  get root(): string {
    return this.#root;
  }

  /**
   * Judge one resolved path against this bundle.
   *
   * @param resolvedPath - Absolute path at or under the bundle root
   * @returns The worst spelling defect on the path, plus both spellings of it
   */
  async judge(resolvedPath: string): Promise<PathSpelling> {
    return await this.judgePath(this.#root, resolvedPath);
  }
}

/** Link types with a local target worth resolving. */
function hasLocalTarget(link: ResourceLink): boolean {
  return link.type === 'local_file' || link.type === 'local_directory';
}

/**
 * Render a name so two spellings that differ only in invisible bytes read as
 * different text.
 *
 * Mandatory for the normalization finding rather than decoration: the whole
 * report is that two strings rendering as the *same glyphs* are different bytes.
 * Quoting both verbatim shows a reader two identical-looking names and asserts
 * they differ, which reads as a VAT bug rather than as a finding.
 *
 * @param name - A path, in whatever form it was asked for or found
 * @returns The same text with every non-printable-ASCII code point escaped
 */
function showBytes(name: string): string {
  return name.replaceAll(/[^ -~]/gu, (char) =>
    String.raw`\u{` + `${(char.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`,
  );
}

/**
 * Whether an href anchors at the bundle root, judged on the DECODED path.
 *
 * Decoding first is what catches `%2F…`, which `resolveLocalHref` resolves as
 * root-anchored but which does not start with a `/` as written. Judging the raw
 * href would give that link the wrong remedy while resolving it by the right
 * rule — the two halves disagreeing about the same string.
 *
 * @param href - The href exactly as the document wrote it
 * @returns True when the path component decodes to a `/`-anchored reference
 */
function isRootAnchored(href: string): boolean {
  const [fileHref] = splitHrefAnchor(href);
  try {
    return decodeURIComponent(fileHref).startsWith('/');
  } catch {
    // Malformed percent-encoding. `resolveLocalHref` falls back to the raw href
    // in the same case, so this has to as well or the two disagree.
    return fileHref.startsWith('/');
  }
}

/** Copy the locating fields every draft carries, so no rule restates them. */
function anchorOf(document: string, link: ResourceLink): Omit<OkfFindingDraft, 'code' | 'message'> {
  return {
    document,
    link: link.href,
    ...(link.line !== undefined && { line: link.line }),
  };
}

/** The finding a link that leaves the bundle earns. */
function escapeDraft(document: string, link: ResourceLink): OkfFindingDraft {
  return {
    ...anchorOf(document, link),
    code: 'OKF_LINK_ESCAPES_BUNDLE',
    message: `Link resolves outside the bundle root, so it does not travel with the bundle (OKF §2 makes the bundle the unit of distribution). Move the target inside the root, or link it as an absolute URL.`,
  };
}

/** The finding a link with no target earns, by which mistake it most likely is. */
function missingDraft(document: string, link: ResourceLink): OkfFindingDraft {
  if (isRootAnchored(link.href)) {
    return {
      ...anchorOf(document, link),
      code: 'OKF_ROOT_RELATIVE_LINK_UNRESOLVED',
      message: 'Root-anchored cross-link does not resolve. In OKF a leading "/" means the BUNDLE root, not the repository root (§6.1) — so a link written for the repository points at nothing once the bundle is unpacked. Re-anchor it relative to this document, or move the target inside the bundle root.',
    };
  }

  return {
    ...anchorOf(document, link),
    code: 'OKF_BROKEN_CROSS_LINK',
    message: 'Cross-link target does not exist in the bundle. OKF §6.1 lets a CONSUMER tolerate this as not-yet-written knowledge; a publisher is the one party who can fix it, so VAT reports it.',
  };
}

/**
 * The finding a link that differs from disk only in letter case earns.
 *
 * 🔑 Its own code rather than {@link missingDraft}'s. The argument that split
 * `OKF_ROOT_RELATIVE_LINK_UNRESOLVED` out was that the remedies differ in KIND,
 * and *write the missing document* differs from *fix the spelling* exactly that
 * way — a dashboard grouping by code cannot separate them under one.
 *
 * @param askedPath - Bundle-relative path the link resolves to, as written
 * @param actualPath - Bundle-relative path the bundle actually holds
 */
function caseDraft(
  document: string,
  link: ResourceLink,
  askedPath: string,
  actualPath: string,
): OkfFindingDraft {
  return {
    ...anchorOf(document, link),
    code: 'OKF_LINK_CASE_MISMATCH',
    message: `Cross-link target is in the bundle under a different case: the link resolves to "${askedPath}" and the bundle holds "${actualPath}" (both relative to the bundle root). This opens on the publisher's machine and 404s on every case-sensitive filesystem the bundle is unpacked onto. Re-spell the link so it resolves to "${actualPath}", or rename what is on disk. Every component is checked, so the path quoted here is the whole correction.`,
  };
}

/** The finding a link that resolves only after Unicode folding earns. */
function normalizationDraft(
  document: string,
  link: ResourceLink,
  askedPath: string,
  actualPath: string,
): OkfFindingDraft {
  return {
    ...anchorOf(document, link),
    code: 'OKF_LINK_NORMALIZATION_MISMATCH',
    message: `Cross-link resolves only after Unicode normalization: the link resolves to "${showBytes(askedPath)}" and the bundle holds "${showBytes(actualPath)}" (both relative to the bundle root). Same visible name, different bytes — it opens on macOS and Windows and 404s on a byte-exact filesystem (Linux), which is where most consumers unpack the bundle. Normalize both to NFC.`,
  };
}

/** A link that got past resolution, waiting on the listing pass to be judged. */
interface ResolvedTarget {
  link: ResourceLink;
  resolvedPath: string;
}

/**
 * Resolve one link, either producing a draft immediately or a target to judge.
 *
 * @param document - Bundle-relative path of the document holding the link
 * @param absolutePath - That document's absolute path, for relative resolution
 * @param link - The link to resolve
 * @param root - Absolute bundle root
 * @returns A finding, a target for the listing pass, or null for anchor-only
 */
function resolveOne(
  document: string,
  absolutePath: string,
  link: ResourceLink,
  root: string,
): { draft: OkfFindingDraft } | { target: ResolvedTarget } | null {
  const resolution = resolveLocalHref(link.href, absolutePath, root);
  if (resolution.kind === 'anchor_only') return null;

  if (resolution.kind !== 'resolved') {
    // `absolute_no_root` is unreachable — a root is always supplied — so any
    // non-resolved kind left here is an escape.
    return { draft: escapeDraft(document, link) };
  }

  // A relative href gets no containment check from `resolveLocalHref`, which
  // only guards the `/`-absolute form. `../elsewhere.md` leaves the bundle
  // just as completely.
  if (!isWithinProject(resolution.resolvedPath, root)) {
    return { draft: escapeDraft(document, link) };
  }

  return { target: { link, resolvedPath: resolution.resolvedPath } };
}

/** Turn one resolved target into a finding, or nothing when it is clean. */
async function judgeTarget(
  document: string,
  target: ResolvedTarget,
  index: BundleDirectoryIndex,
): Promise<OkfFindingDraft | null> {
  const verdict = await index.judge(target.resolvedPath);

  switch (verdict.match) {
    case 'exact': {
      return null;
    }
    case 'normalized': {
      return normalizationDraft(document, target.link, verdict.askedPath, verdict.actualPath);
    }
    case 'case_mismatch': {
      return caseDraft(document, target.link, verdict.askedPath, verdict.actualPath);
    }
    case 'absent': {
      return missingDraft(document, target.link);
    }
  }
}

/**
 * Resolve every cross-link in one document and report the ones that fail.
 *
 * Two passes: every target is resolved first (pure path work), then the
 * spellings are judged against the bundle's directory index, which does the
 * listings once each and shares them across every document in the bundle.
 *
 * @param document - Bundle-relative path of the document holding the links
 * @param absolutePath - That document's absolute path, for relative resolution
 * @param links - Links the parser found
 * @param root - Absolute bundle root; `/`-prefixed hrefs resolve against it
 * @param index - The bundle's directory index, shared across its documents so a
 *   directory holding N link targets is listed once, not N times
 */
export async function linkFindings(
  document: string,
  absolutePath: string,
  links: readonly ResourceLink[],
  root: string,
  index: BundleDirectoryIndex,
): Promise<OkfFindingDraft[]> {
  const drafts: OkfFindingDraft[] = [];
  const targets: ResolvedTarget[] = [];

  for (const link of links) {
    if (!hasLocalTarget(link)) continue;

    const outcome = resolveOne(document, absolutePath, link, root);
    if (outcome === null) continue;
    if ('draft' in outcome) {
      drafts.push(outcome.draft);
    } else {
      targets.push(outcome.target);
    }
  }

  const judged = await Promise.all(
    targets.map(async (target) => await judgeTarget(document, target, index)),
  );
  for (const draft of judged) {
    if (draft !== null) drafts.push(draft);
  }

  return drafts;
}
