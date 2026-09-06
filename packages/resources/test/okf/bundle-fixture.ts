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

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
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

/** The finding codes a report carries, in report order. */
export function codesOf(findings: ReadonlyArray<{ code: string }>): string[] {
  return findings.map((finding) => finding.code);
}
