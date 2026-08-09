/**
 * Validation for numeric command-line arguments.
 *
 * Deliberately free of any CLI-framework types: the rule is "is this a whole
 * number at or above a floor", which has nothing to do with Commander. Callers
 * that need a framework-specific error catch this one and re-raise, which is
 * what lets a CLI print a usage message while the rule itself stays testable
 * without a parser.
 */

/**
 * Parse a whole number that must be at or above a floor.
 *
 * The error names the flag as the user spelled it, because "expects a whole
 * number" without saying *which* option is a message that sends someone back to
 * `--help` to guess.
 *
 * @param value - Raw string as typed on the command line
 * @param floor - Smallest value that makes sense for this option
 * @param flag - Flag spelling, used in the error message
 * @returns The parsed number
 * @throws Error when the value is not a whole number at or above the floor
 */
export function parseWholeNumberAtLeast(value: string, floor: number, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < floor) {
    throw new Error(
      `${flag} expects a whole number of at least ${String(floor)}; got '${value}'.`,
    );
  }
  return parsed;
}
