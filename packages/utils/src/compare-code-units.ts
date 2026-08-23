/**
 * Host-independent string ordering, for sorts whose output is hashed or compared
 * across machines.
 *
 * ## Why this is not `localeCompare`
 *
 * `sonarjs/no-alphabetical-sort` fires on a bare `strings.sort()` and its suggested fix is a
 * `localeCompare` comparator. **That fix is wrong for anything whose order feeds a digest, a
 * content key, a serialized document or a golden file.** Collation is locale-dependent, so two
 * machines running the same code over the same corpus can order the same strings differently —
 * destroying exactly the cross-run comparability those artifacts exist to provide. The rule only
 * requires *a* comparator; this is the one to give it.
 *
 * Code-unit order is total, stable and machine-independent. It is not alphabetical in any human
 * sense (uppercase sorts before lowercase, `10` before `2`), which is fine — callers using it are
 * ordering bytes for a machine, not a list for a reader. Sort numbers numerically instead.
 *
 * This lives in `utils` because it had independently grown three identical private copies (in
 * `resources`' projection digest and blob population, and in `claude-marketplace`' plugin extent)
 * and a fourth was nearly written. Three copies of a "never use `localeCompare`" rule is three
 * chances for someone to helpfully replace one of them.
 *
 * @param left - First string
 * @param right - Second string
 * @returns Negative, zero or positive per the `Array.prototype.sort` contract
 */
export function compareCodeUnits(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
