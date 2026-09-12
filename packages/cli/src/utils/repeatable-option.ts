/**
 * The collector every REPEATABLE option in this CLI uses, and the reason none
 * of them is variadic.
 *
 * Commander offers two spellings for "this flag takes several values":
 *
 * - **Variadic** — `--param <values...>`, which consumes every following token
 *   up to the next option-shaped one.
 * - **Repeatable** — `--param <value>` passed more than once, accumulated by a
 *   custom collector. This one.
 *
 * The variadic spelling is unusable on a command that also has a positional
 * argument, and every command here has one. It ate the positional:
 * `vat resources query 'SELECT ? AS x, ? AS y' --param a docs/` bound `docs/`
 * as the SECOND SQL VALUE, left the `[path]` positional unread, and reported
 * `status: success` at exit 0 with `y: 'docs/'` in its rows — a token the
 * operator typed as a location, silently reinterpreted as data. On
 * `vat skill test run <skill>` the same shape consumed the subject and the run
 * died claiming the subject was missing.
 *
 * ⚠️ What the swallowed token would have DONE is a separate question, and on
 * `query` the answer is "located the project": `[path]` there is a root
 * locator, not a scope — see `queryCommand` — so an earlier reading of this
 * incident as "answered about the whole tree instead of `docs/`" claimed a
 * scoping the verb never had. The defect this module fixes is the swallow.
 *
 * So: no variadic options. `test/commands/no-variadic-cli-options.test.ts`
 * enforces that against the source, because the defect is a declaration shape
 * rather than a bug in any one command.
 *
 * @param value - The value Commander parsed for this occurrence of the flag
 * @param previous - What earlier occurrences accumulated, or `undefined` for the first
 * @returns A NEW array — never a mutation of `previous`, which on a defaulted
 *   option is shared by every parse of the same `Option` instance
 */
export function collectRepeated(value: string, previous?: readonly string[]): string[] {
  return [...(previous ?? []), value];
}
