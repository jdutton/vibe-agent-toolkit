/**
 * Global vitest setup file
 *
 * Runs once per test worker before any test files are loaded.
 * Prevents parent-process environment variables from leaking into tests.
 *
 * Pattern borrowed from vibe-validate's test hardening.
 */

// Clear environment variables that could leak from parent process
// (e.g., VV_FORCE_EXECUTION=1 from `vv validate` running pre-commit hooks).
//
// Allowlist: intentional, explicitly-set test opt-ins must survive the scrub.
// VAT_SKILL_TEST_E2E gates the token-spending end-to-end skill-test block in
// skill-test.system.test.ts. The skipIf gate is evaluated at module-load — if we
// deleted the var here (setup runs first), that block could NEVER run, which is
// exactly how the real `claude` spawn path shipped untested. CI does not set it,
// so token spend stays opt-in only.
// VAT_FAULT_MATRIX=full selects the fault matrix's whole injection product for a
// local run (packages/cli/test/fault-matrix/matrix.ts); scrubbed, it could never be chosen.
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter } from 'node:path';

const PRESERVE_ENV = new Set(['VAT_SKILL_TEST_E2E', 'VAT_FAULT_MATRIX']);

// ⛔ Never leave a test pointed at a real Claude configuration. `vat` reads
// CLAUDE_CONFIG_DIR before HOME, so a developer's own value aims every install,
// uninstall and clear a test runs without its own stub at their live config — and
// DELETING it is no fix: unset falls back to `$HOME/.claude`, which is just as real.
// So the default every worker starts from is a scratch path under the temp
// directory that nothing creates. A test that wants `$HOME/.claude` stubs HOME and
// blanks this variable itself (`vi.stubEnv('CLAUDE_CONFIG_DIR', '')`), and when its
// stubs are undone it lands back here, not on the real one. Both failures happened:
// a reproduction, and then a test whose second run came after its stubs were
// undone, each installed a fixture plugin into a live Claude config.
// (enforced by: packages/dev-tools/test/vitest-setup-env.test.ts)
process.env.CLAUDE_CONFIG_DIR = `${tmpdir()}/vat-test-no-claude-config-${process.pid}`;
for (const key of Object.keys(process.env)) {
	if ((key.startsWith('VAT_') || key.startsWith('VV_')) && !PRESERVE_ENV.has(key)) {
		delete process.env[key];
	}
}

// …and fail CLOSED where the default above is not enough. A test may blank or unset
// CLAUDE_CONFIG_DIR (to exercise the HOME fallback) without pointing HOME at a temp
// directory, and then the Claude directory is the ambient home's — as is every other
// target's user-scope skills directory, and the session store. Each resolver of such
// a root (`requireTestScratch`, utils) throws when this variable is set and the
// directory it resolved is outside the tree it names — before any path is handed out. Set
// AFTER the scrub above (it is a VAT_ variable), and inherited by every `vat` child
// a test spawns, so a system test that forgets `fakeHomeEnv` stops the same way.
// (enforced by: packages/claude-marketplace/test/test-env-guarantee.ts, declared in the unit,
// integration and system lanes of that package; packages/utils/test/test-scratch-guard.test.ts)
// Both spellings of the temp directory (on macOS `/var/…` is a link to `/private/var/…`): the
// resolver compares spellings and makes no filesystem call of its own.
process.env.VAT_TEST_USER_STATE_UNDER = [...new Set([tmpdir(), realpathSync.native(tmpdir())])].join(delimiter);
