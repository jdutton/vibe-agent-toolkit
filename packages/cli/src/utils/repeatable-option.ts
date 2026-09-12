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
 * as the second SQL parameter, ran against the repository root instead of
 * `docs/`, and reported `status: success` at exit 0 — the user asked about one
 * directory and was confidently answered about the whole tree. On
 * `vat skill test run <skill>` the same shape consumed the subject and the run
 * died claiming the subject was missing.
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
