/**
 * The ONE predicate deciding whether a projection value may become a finding's
 * `location`.
 *
 * A module rather than two private helpers because both lanes that turn rows
 * into findings — adopter SQL (`sql-checks.ts`) and built-in predicates
 * (`builtin-checks.ts`) — need the identical answer, and a second copy is the
 * *two contracts for one thing* drift class.
 *
 * 🪤 **Nothing downstream re-checks this.** Neither lane's findings are parsed
 * through `ValidationIssueSchema` before publication, so deleting a clause here
 * emits an issue violating that schema's refined `location` with no gate
 * catching it — and `validation.allow` globs match against `location`, so such a
 * value would silently match no allow entry an adopter wrote.
 *
 * 📌 A path naming a **DIRECTORY** keeps its anchor, decided rather than
 * overlooked: nothing here opens a filesystem, so `docs` the directory and
 * `docs` the extension-less file are indistinguishable, and refusing every
 * extension-less path would unanchor `LICENSE` and `Makefile` to catch a rarer
 * case. The consequence: `docs/**` does not match the bare directory `docs`;
 * allow the directory itself when a check selects directory rows.
 */

/** A drive-lettered Windows path, which is absolute however POSIX it looks. */
const WINDOWS_DRIVE = /^[A-Za-z]:/;

/**
 * The value as a finding's location, when it can be one.
 *
 * Every projection table stores root-relative POSIX paths, so the refusals below
 * only fire on a value something BUILT — a statement that concatenated a root
 * onto a column, or a producer that forgot to relativize.
 *
 * @param value - Whatever the row held, undecoded
 * @returns The location, or undefined when the value cannot honestly be one
 */
export function findingLocation(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (value.includes('\\')) return undefined;
  if (value.startsWith('/') || WINDOWS_DRIVE.test(value)) return undefined;
  return value;
}
