/**
 * Turn a projection value into a finding's `location`, when it can be one.
 *
 * A module rather than two private helpers because both lanes that turn rows
 * into findings — adopter SQL (`sql-checks.ts`) and built-in predicates
 * (`builtin-checks.ts`) — need the identical answer. The RULE itself is not here:
 * it is `isProjectLocation` in `@vibe-agent-toolkit/schema`, the same predicate
 * `ValidationIssueSchema.location` refines with, so a location this module emits
 * is one the published schema parses. A second copy of the rule is the *two
 * contracts for one thing* drift class.
 *
 * 📌 A path naming a **DIRECTORY** keeps its anchor, decided rather than
 * overlooked: nothing here opens a filesystem, so `docs` the directory and
 * `docs` the extension-less file are indistinguishable, and refusing every
 * extension-less path would unanchor `LICENSE` and `Makefile` to catch a rarer
 * case. The consequence: `docs/**` does not match the bare directory `docs`;
 * allow the directory itself when a check selects directory rows.
 */

import { projectLocationOf } from '@vibe-agent-toolkit/schema';

/**
 * The value as a finding's location, when it can be one.
 *
 * @param value - Whatever the row held, undecoded
 * @returns The location (a leading `./` dropped), or undefined when the value is not text or is text
 *   that is no location (absolute, drive-prefixed, climbing, empty, or
 *   backslashed where `\` is the platform separator)
 */
export function findingLocation(value: unknown): string | undefined {
  return typeof value === 'string' ? projectLocationOf(value) : undefined;
}
