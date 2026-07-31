/**
 * A passing `runPreflight` stub, shared by every test that drives
 * `runSkillTestHarness` end to end.
 *
 * Preflight probes the real environment: it shells out to `claude --version` and
 * parses `--plugin-dir` / `--setting-sources` / `--output-format` /
 * `--permission-mode` support out of that binary. CI has no `claude` (not a
 * dependency, not in `node_modules/.bin`), so a harness test that does not stub
 * this exits 2 on CI while passing on any developer machine with Claude Code
 * installed — a test that measures the environment rather than the code.
 *
 * It takes `importOriginal` rather than the already-awaited module so the whole
 * mock is one statement at the call site:
 *
 * ```ts
 * vi.mock('../../src/skill-test/preflight.js', async (io) => (await import('./preflight-stub.js')).passingPreflight(io));
 * ```
 *
 * That shape matters. `vi.mock` factories are hoisted above the test file's
 * imports, so the helper has to be reached by dynamic `import()` inside the
 * factory — and five files each spelling that out over five lines is a clone.
 * Every earlier copy was contorted into a gratuitously different shape (key
 * order, a populated `checks` entry) purely to stay under the duplication gate,
 * with a comment in each file explaining the contortion. One statement leaves
 * nothing to duplicate.
 */
import { vi } from 'vitest';

import type { PreflightResult } from '../../src/skill-test/preflight.js';

/** The shape a `vi.mock` factory returns: the real module with `runPreflight` replaced. */
type MockedModule = Record<string, unknown>;

/**
 * Build the module a `vi.mock('.../preflight.js')` factory should return.
 *
 * `resolvedAuth` defaults to non-null with an empty `forwardedEnv`: env assembly
 * refuses a null, and an empty forwarded env is the honest stand-in for "no
 * credentials to forward" — `assembleChildEnv` still layers the run's own
 * declared `injectEnv` on top, so declared-env assertions stay meaningful. Pass
 * `{ resolvedAuth: null }` for gates that return before auth is consulted.
 *
 * @param importOriginal The factory's own `importOriginal`, unawaited.
 * @param overrides Fields to override on the stubbed `PreflightResult`.
 */
export async function passingPreflight(
  importOriginal: () => Promise<MockedModule>,
  overrides: Partial<PreflightResult> = {},
): Promise<MockedModule> {
  const actual = await importOriginal();
  const result: PreflightResult = {
    checks: [],
    passed: true,
    resolvedAuth: { forwardedEnv: {}, effectiveMechanism: 'api-key' },
    ...overrides,
  };
  return { ...actual, runPreflight: vi.fn(() => result) };
}
