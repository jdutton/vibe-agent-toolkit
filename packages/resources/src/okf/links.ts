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
 * So the same two-pass judge VAT's own link validator uses answers it instead:
 * {@link fillSiblingNames} lists each target's parent directory once, and
 * {@link classifyFilenameCaseFrom} compares the asked-for basename against the
 * entries actually on disk. That yields three distinguishable verdicts where
 * `stat()` yielded one boolean — and `link-validator.ts` already reports two of
 * them at error severity over the identical corpus, so before this the two lanes
 * of one product disagreed about whether the same bundle was broken.
 *
 * ## ⛔ Why there is no is-it-a-directory check
 *
 * There was one, costing an `fs.stat` per resolved target, and nothing read the
 * answer except a `local_directory` link pointing at a regular file. VAT's own
 * `validateResolvedFile` dropped the equivalent check for exactly that reason.
 * Keeping a second, differently-behaved oracle in this lane would mean a link
 * VAT calls broken in one command and fine in the other.
 */

import { basename } from 'node:path';

import {
  classifyFilenameCaseFrom,
  fillSiblingNames,
  type FsLookupCache,
  type SiblingNamesTable,
} from '@vibe-agent-toolkit/utils';

import type { ResourceLink } from '../types.js';
import { isWithinProject, resolveLocalHref, splitHrefAnchor } from '../utils.js';

import type { OkfFindingDraft } from './findings.js';

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
 * @param name - A filename, in whatever form it was asked for or found
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

/** The finding a link that differs from disk only in letter case earns. */
function caseDraft(
  document: string,
  link: ResourceLink,
  askedName: string,
  actualName: string,
): OkfFindingDraft {
  return {
    ...anchorOf(document, link),
    code: 'OKF_BROKEN_CROSS_LINK',
    message: `Cross-link target is in the bundle under a different case: the link asks for "${askedName}" and the bundle holds "${actualName}". This opens on the publisher's machine and 404s on every case-sensitive filesystem the bundle is unpacked onto. Spell the link "${actualName}", or rename the file.`,
  };
}

/** The finding a link that resolves only after Unicode folding earns. */
function normalizationDraft(
  document: string,
  link: ResourceLink,
  askedName: string,
  actualName: string,
): OkfFindingDraft {
  return {
    ...anchorOf(document, link),
    code: 'OKF_LINK_NORMALIZATION_MISMATCH',
    message: `Cross-link resolves only after Unicode normalization: the link spells the filename "${showBytes(askedName)}" and the file on disk is named "${showBytes(actualName)}". Same visible name, different bytes — it opens on macOS and Windows and 404s on a byte-exact filesystem (Linux), which is where most consumers unpack the bundle. Normalize both to NFC.`,
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

/** Turn one classified target into a finding, or nothing when it is clean. */
function judgeTarget(
  document: string,
  target: ResolvedTarget,
  siblingNames: SiblingNamesTable,
): OkfFindingDraft | null {
  const verdict = classifyFilenameCaseFrom(siblingNames, target.resolvedPath);
  // The DECODED basename: `%20`-escaped hrefs are already unescaped by
  // `resolveLocalHref`, and the reader needs the name to compare against disk,
  // not the transport encoding of it.
  const askedName = basename(target.resolvedPath);

  switch (verdict.match) {
    case 'exact': {
      return null;
    }
    case 'normalized': {
      return verdict.actualName === null
        ? null
        : normalizationDraft(document, target.link, askedName, verdict.actualName);
    }
    case 'case_mismatch': {
      return verdict.actualName === null
        ? missingDraft(document, target.link)
        : caseDraft(document, target.link, askedName, verdict.actualName);
    }
    case 'absent': {
      return missingDraft(document, target.link);
    }
  }
}

/**
 * Resolve every cross-link in one document and report the ones that fail.
 *
 * Two passes, in the order the fill/judge pair requires: every target is
 * resolved first, then their parent directories are listed once each, then the
 * spellings are judged against those listings with no further I/O.
 *
 * @param document - Bundle-relative path of the document holding the links
 * @param absolutePath - That document's absolute path, for relative resolution
 * @param links - Links the parser found
 * @param root - Absolute bundle root; `/`-prefixed hrefs resolve against it
 * @param fsCache - Per-run lookup cache, shared across the bundle's documents so
 *   a directory holding N link targets is listed once, not N times
 */
export async function linkFindings(
  document: string,
  absolutePath: string,
  links: readonly ResourceLink[],
  root: string,
  fsCache: FsLookupCache,
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

  const siblingNames = await fillSiblingNames(
    targets.map((target) => target.resolvedPath),
    fsCache,
  );

  for (const target of targets) {
    const draft = judgeTarget(document, target, siblingNames);
    if (draft !== null) drafts.push(draft);
  }

  return drafts;
}
