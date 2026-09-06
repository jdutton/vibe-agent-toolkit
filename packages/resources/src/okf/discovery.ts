/**
 * Enumerate the documents an OKF bundle is judged over.
 *
 * ## Why this is a bare recursive walk and not `crawlDirectory`
 *
 * OKF's conformance population is **spec-defined and maximal**: §3.1 reserves
 * exactly `index.md` and `log.md` and then says *"All other `.md` files are
 * concept documents"*, and §11 requires every one of them to carry parseable
 * frontmatter with a non-empty `type`. Anything that narrows the walk is
 * therefore not an optimisation but a correctness hole — VAT would report a
 * clean bundle while a file it never opened broke conformance.
 *
 * `crawlDirectory` narrows in two ways that matter here. It answers from
 * `git ls-files` by default, so an untracked concept document is invisible (the
 * documented `git-route-hides-untracked` trap), and its `NEVER_CRAWL_GLOBS`
 * drop whole subtrees on a relevance judgement that has no standing inside a
 * bundle root. Neither is wrong for a project scan; both are wrong for this.
 *
 * So: `readdir` with `withFileTypes`, every directory, no excludes, no globs.
 * If a subtree must not be part of a bundle, it must not be under the bundle
 * root — see the `OkfBundleConfigSchema` docstring for the ruling.
 *
 * ## The two case rules point in opposite directions, deliberately
 *
 * Extension matching is case-**insensitive** (`.MD` counts) because that widens
 * the population — a file a consumer would read as markdown cannot slip past
 * the checks. Reserved-name matching is case-**sensitive** (`Index.md` is a
 * concept document) because being reserved *exempts* a file from those checks,
 * and an exemption inferred from a case fold is an exemption VAT invented.
 */

import { readdir } from 'node:fs/promises';

import { compareCodeUnits, safePath } from '@vibe-agent-toolkit/utils';

/**
 * The filenames §3.1 reserves, at any level of the hierarchy.
 *
 * Not a configuration surface: a bundle whose author repurposes `log.md` as a
 * concept is not an OKF bundle, so there is nothing to make adjustable.
 */
const RESERVED_FILENAMES: ReadonlySet<string> = new Set(['index.md', 'log.md']);

/** The documents beneath a bundle root, split by what the spec makes of them. */
export interface OkfBundleFiles {
  /**
   * Every non-reserved `.md`, bundle-relative with forward slashes, sorted.
   * These are the documents §11's items 1 and 2 apply to.
   */
  conceptDocuments: string[];
  /**
   * Every `index.md` / `log.md`, bundle-relative with forward slashes, sorted.
   * Exempt from the concept-document requirement — but the bundle-root
   * `index.md` is still read, for the `okf_version` cross-check (§12).
   */
  reservedDocuments: string[];
}

/** Whether a filename is markdown, judged case-insensitively (widens). */
function isMarkdownFilename(name: string): boolean {
  return name.toLowerCase().endsWith('.md');
}

/**
 * Walk one directory and everything beneath it, appending to the accumulators.
 *
 * Symlinked directories are not followed: a bundle is a distributable tree, and
 * a link out of it does not travel with the tarball. A symlinked *file* is read
 * like any other, because its bytes do travel when the bundle is packed.
 *
 * @param root - Absolute bundle root, for computing relative paths
 * @param dir - Absolute directory to walk
 * @param found - Accumulators, mutated in place
 */
async function walkInto(root: string, dir: string, found: OkfBundleFiles): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a bundle root the adopter's own config named, plus directory names read from it
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const absolute = safePath.join(dir, entry.name);

    if (entry.isDirectory()) {
      await walkInto(root, absolute, found);
      continue;
    }

    if (!entry.isFile() || !isMarkdownFilename(entry.name)) {
      continue;
    }

    const relative = safePath.relative(root, absolute);
    if (RESERVED_FILENAMES.has(entry.name)) {
      found.reservedDocuments.push(relative);
    } else {
      found.conceptDocuments.push(relative);
    }
  }
}

/**
 * Enumerate every markdown document beneath a bundle root.
 *
 * @param root - Absolute path to the bundle root
 * @returns Concept and reserved documents, bundle-relative and sorted
 * @throws If the root cannot be read — an unreadable root is a finding about
 *   the configuration, never an empty (and therefore trivially conformant)
 *   bundle
 */
export async function discoverOkfBundle(root: string): Promise<OkfBundleFiles> {
  const found: OkfBundleFiles = { conceptDocuments: [], reservedDocuments: [] };
  await walkInto(root, root, found);

  // `compareCodeUnits`, never a bare `.sort()`: order here is machine order, and
  // a locale collation would make two machines report the same bundle differently.
  found.conceptDocuments.sort(compareCodeUnits);
  found.reservedDocuments.sort(compareCodeUnits);
  return found;
}
