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
const PRESERVE_ENV = new Set(['VAT_SKILL_TEST_E2E']);
for (const key of Object.keys(process.env)) {
	if ((key.startsWith('VAT_') || key.startsWith('VV_')) && !PRESERVE_ENV.has(key)) {
		delete process.env[key];
	}
}
