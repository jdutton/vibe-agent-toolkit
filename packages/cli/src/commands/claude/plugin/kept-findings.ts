/**
 * The finding for a plugin directory an uninstall (or a `vat.replaces` uninstall) kept because a
 * sibling it may be the same entry as could not be examined (ruling R7 d-I-1: never delete what may
 * BE a kept sibling). The registry entry still goes; the finding names the kept directory by its
 * exact path, so the user — and the fault matrix — can tell what was left and why.
 */

import type { ValidationIssue } from '@vibe-agent-toolkit/schema';

/** The code of {@link keptForSiblingFindings}. */
export const PLUGIN_KEPT_SIBLING_UNEXAMINED = 'PLUGIN_KEPT_SIBLING_UNEXAMINED';

/**
 * One warning per directory kept because a sibling could not be examined. The kept directory is its
 * `link` (the target the finding concerns): a report's `location` is project-relative, and this is
 * an absolute path in the Claude user directory.
 */
export function keptForSiblingFindings(kept: readonly { readonly path: string; readonly sibling: string }[]): ValidationIssue[] {
  return kept.map(({ path, sibling }) => ({
    code: PLUGIN_KEPT_SIBLING_UNEXAMINED,
    severity: 'warning',
    message: `Kept ${path}: the OS refused to examine ${sibling}, so whether ${path} is that same entry could not be told. `
      + 'The registry no longer names it.',
    link: path,
    fix: `Make ${sibling} readable, then remove ${path} if nothing uses it.`,
  }));
}
