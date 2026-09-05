/**
 * System test for bin wrapper (vat command)
 * Tests that the bin wrapper correctly detects context and executes
 */

import fs from 'node:fs';

import { afterAll, describe, expect, it } from 'vitest';

import { createTestTempDir, executeBunVat, join, writeTestFile } from './test-common.js';

describe('Bin wrapper (vat command)', () => {
  it('should execute vat command with bun run', async () => {
    // Test the dev convenience script
    const result = await executeBunVat(import.meta.url, ['--version']);

    expect(result.status).toBe(0);
    // Bounded digit runs, so the match cannot backtrack super-linearly.
    expect(result.stdout).toMatch(/\d{1,9}\.\d{1,9}\.\d{1,9}/);
  });

  it('should handle --help flag', async () => {
    const result = await executeBunVat(import.meta.url, ['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Agent-friendly toolkit');
    expect(result.stdout).toContain('resources');
  });

  it('should handle --help --verbose flag', async () => {
    const result = await executeBunVat(import.meta.url, ['--help', '--verbose']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('# vat - Vibe Agent Toolkit CLI');
    expect(result.stdout).toContain('## Commands');
  });

  it('should pass through subcommands correctly', async () => {
    const result = await executeBunVat(import.meta.url, ['resources', '--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Markdown resource scanning');
  });
});

/**
 * `-v` must reach the SUBCOMMAND, not the root program.
 *
 * The root used to register `.version(…, '-v, --version')`. Commander resolves a
 * root option before the subcommand's own, so that single short flag shadowed the
 * `-v, --verbose` that validate/verify/build/skills-build each advertise in their
 * own --help: `vat validate -v` printed the version and exited 0 having validated
 * nothing. A CI step spelled that way was a permanently-green gate.
 *
 * This has to be a SYSTEM test. The unit-level sibling in
 * `test/commands/default-summary-listings.test.ts` calls `parseOptions(['-v'])` on
 * a subcommand built in ISOLATION, where the flag has always resolved correctly —
 * a fixture that cannot distinguish the two answers, which is what let the defect
 * sit under a green suite. Only the assembled program shows the shadowing.
 */
describe('root --version does not shadow subcommand -v/--verbose', () => {
  const tempDir = createTestTempDir('vat-verbose-shadow-');

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('still serves the long form at the root', async () => {
    const result = await executeBunVat(import.meta.url, ['--version']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('binary:');
  });

  it('no longer claims the bare short flag at the root', async () => {
    const result = await executeBunVat(import.meta.url, ['-v']);

    // `binary:` is the version output's unmistakable second line.
    expect(result.stdout).not.toContain('binary:');
    expect(result.status).not.toBe(0);
  });

  it('routes -v to the subcommand as --verbose instead of printing the version', async () => {
    writeTestFile(join(tempDir, 'note.md'), '# Note\n\nNo links here.\n');

    const result = await executeBunVat(import.meta.url, ['resources', 'validate', '-v', tempDir]);

    // The defect: this printed the version and exited 0 without validating.
    expect(result.stdout).not.toContain('binary:');
    expect(result.stdout).toContain('filesScanned:');
    expect(result.status).toBe(0);
  });

  // `doctor` is the verb freeing `-v` at the root MISSED. Every sibling above
  // advertises `-v, --verbose`; `doctor` registered the long form alone, so the
  // flag it no longer shadowed arrived as an UNKNOWN option — `vat doctor -v`
  // exited 1 with `error: unknown option '-v'`, having diagnosed nothing. The
  // short form was never "restored" for doctor because doctor never had it.
  //
  // Asserted through the assembled program for the reason in this block's header:
  // a `parseOptions(['-v'])` call on a `doctor` command built in isolation is the
  // fixture that cannot fail.
  it('routes -v to doctor, which had advertised only the long form', async () => {
    const result = await executeBunVat(import.meta.url, ['doctor', '-v']);

    expect(result.stderr).not.toContain("unknown option '-v'");
    // Doctor's banner. Its exit code is environment-dependent (a failed check is
    // a legitimate 1), so the parse is what this asserts, not the diagnosis.
    expect(result.stdout).toContain('vat doctor');
  });

  // `audit` is the OTHER verb the root cleanup missed, and the one an adopter is
  // most likely to have spelled `-v` in CI. Same shape as doctor: long form only,
  // so the freed flag arrived as an unknown option and exited 1.
  it('routes -v to audit, which had advertised only the long form', async () => {
    const result = await executeBunVat(import.meta.url, ['audit', '--help']);

    expect(result.stdout).toContain('-v, --verbose');
    expect(result.stderr).not.toContain("unknown option '-v'");
  });
});
