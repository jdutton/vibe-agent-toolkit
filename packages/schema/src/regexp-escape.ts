/** Every character that means something other than itself inside a regex. */
const REGEXP_METACHARACTERS = /[$()*+.?[\\\]^{|}]/g;

/**
 * Quote a literal so it can be spliced into a regex source.
 *
 * Used where a rule is DERIVED into a pattern rather than restated as one —
 * `CUSTOM_CHECK_CODE_PATTERN_SOURCE` and the `validation.severity` key pattern
 * are both composed from constants that live elsewhere, and a code or prefix
 * that ever grew a `.` or a `+` would otherwise quietly start matching keys
 * nobody declared.
 *
 * @param text - The literal to quote
 * @returns A regex source matching exactly `text`
 */
export function escapeRegExpLiteral(text: string): string {
  return text.replaceAll(REGEXP_METACHARACTERS, String.raw`\$&`);
}
