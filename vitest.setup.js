/**
 * Global vitest setup file
 *
 * Runs once per test worker before any test files are loaded.
 * Prevents parent-process environment variables from leaking into tests.
 *
 * Pattern borrowed from vibe-validate's test hardening.
 */

// Clear environment variables that could leak from parent process
// (e.g., VV_FORCE_EXECUTION=1 from `vv validate` running pre-commit hooks)
for (const key of Object.keys(process.env)) {
	if (key.startsWith('VAT_') || key.startsWith('VV_')) {
		delete process.env[key];
	}
}
