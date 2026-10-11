/**
 * The exact shape of an unknown-key refusal, shared by the unit and integration
 * suites that pin it.
 *
 * A message match such as `/type/` is satisfied by ANY ZodError that mentions a
 * field called `type` — an `invalid_type` issue on a declared key reads the same.
 * So the refusal is pinned on its issue list instead: exactly one
 * `unrecognized_keys` issue, naming exactly these keys at exactly this path.
 */
import { expect } from 'vitest';
import { ZodError } from 'zod';

/**
 * Assert that `error` is the strict schema's unknown-key refusal and nothing else.
 *
 * @param error - What the call threw or rejected with
 * @param keys - The unknown keys, in the order the object declared them
 * @param path - Where the offending object sits in the parsed value
 */
export function expectUnrecognizedKeys(error: unknown, keys: readonly string[], path: readonly (string | number)[]): void {
  expect(error).toBeInstanceOf(ZodError);
  const issues = (error as ZodError).issues.map((issue) => ({
    code: issue.code,
    keys: 'keys' in issue ? issue.keys : undefined,
    path: issue.path,
  }));
  expect(issues).toEqual([{ code: 'unrecognized_keys', keys, path }]);
}

/**
 * Run `call` and return what it threw, failing the test if it did not throw.
 *
 * @param call - The call expected to refuse
 * @returns The thrown value
 */
export async function caughtFrom(call: () => unknown): Promise<unknown> {
  try {
    await call();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to refuse, and it returned normally');
}
