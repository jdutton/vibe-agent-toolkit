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
 */

import { stat } from 'node:fs/promises';

import type { ResourceLink } from '../types.js';
import { isWithinProject, resolveLocalHref } from '../utils.js';

import type { OkfFindingDraft } from './findings.js';

/** Link types with a local target worth resolving. */
function hasLocalTarget(link: ResourceLink): boolean {
  return link.type === 'local_file' || link.type === 'local_directory';
}

/** Whether the resolved path exists, and is the kind of thing the href asked for. */
async function targetExists(resolvedPath: string, wantsDirectory: boolean): Promise<boolean> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path resolved from an adopter's own bundle content, already confined to the bundle root by the caller
    const stats = await stat(resolvedPath);
    return wantsDirectory ? stats.isDirectory() : true;
  } catch {
    return false;
  }
}

/** The finding a link that leaves the bundle earns. */
function escapeDraft(document: string, link: ResourceLink): OkfFindingDraft {
  return {
    code: 'OKF_LINK_ESCAPES_BUNDLE',
    document,
    link: link.href,
    ...(link.line !== undefined && { line: link.line }),
    message: `Link resolves outside the bundle root, so it does not travel with the bundle (OKF §2 makes the bundle the unit of distribution). Move the target inside the root, or link it as an absolute URL.`,
  };
}

/** The finding a link with no target earns. */
function brokenDraft(document: string, link: ResourceLink): OkfFindingDraft {
  return {
    code: 'OKF_BROKEN_CROSS_LINK',
    document,
    link: link.href,
    ...(link.line !== undefined && { line: link.line }),
    message: 'Cross-link target does not exist in the bundle. OKF §6.1 lets a CONSUMER tolerate this as not-yet-written knowledge; a publisher is the one party who can fix it, so VAT reports it.',
  };
}

/**
 * Resolve every cross-link in one document and report the ones that fail.
 *
 * @param document - Bundle-relative path of the document holding the links
 * @param absolutePath - That document's absolute path, for relative resolution
 * @param links - Links the parser found
 * @param root - Absolute bundle root; `/`-prefixed hrefs resolve against it
 */
export async function linkFindings(
  document: string,
  absolutePath: string,
  links: readonly ResourceLink[],
  root: string,
): Promise<OkfFindingDraft[]> {
  const drafts: OkfFindingDraft[] = [];

  for (const link of links) {
    if (!hasLocalTarget(link)) continue;

    const resolution = resolveLocalHref(link.href, absolutePath, root);
    if (resolution.kind === 'anchor_only') continue;
    if (resolution.kind !== 'resolved') {
      // `absolute_no_root` is unreachable — a root is always supplied — so any
      // non-resolved kind left here is an escape.
      drafts.push(escapeDraft(document, link));
      continue;
    }

    // A relative href gets no containment check from `resolveLocalHref`, which
    // only guards the `/`-absolute form. `../elsewhere.md` leaves the bundle
    // just as completely.
    if (!isWithinProject(resolution.resolvedPath, root)) {
      drafts.push(escapeDraft(document, link));
      continue;
    }

    if (!await targetExists(resolution.resolvedPath, link.type === 'local_directory')) {
      drafts.push(brokenDraft(document, link));
    }
  }

  return drafts;
}
