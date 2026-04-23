/* eslint-disable security/detect-non-literal-fs-filename */
// Test helpers legitimately use dynamic paths

/**
 * CLI execution helpers for system tests
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';


import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import * as yaml from 'js-yaml';
import { expect } from 'vitest';

import { setupTestProject } from './project-setup.js';

/**
 * Parse YAML output from CLI commands
 * Handles output with --- document markers
 */
export function parseYamlOutput(stdout: string): Record<string, unknown> {
  // Extract content between --- markers
  const parts = stdout.split('---\n').filter(part => part.trim());

  if (parts.length === 0) {
    throw new Error('No YAML content found in output');
  }

  // Parse the first document (there should only be one valid document)
  const yamlContent = parts[0];
  return yaml.load(yamlContent) as Record<string, unknown>;
}

/**
 * Common result type for CLI execution
 */
export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Execute CLI command and return result
 *
 * Uses file-based output capture to avoid Bun's 64KB spawnSync buffer limit.
 * This is necessary for commands that produce large YAML outputs (e.g., audit).
 */
export function executeCli(
  binPath: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv }
): CliResult {
  // Create temp files for stdout/stderr to avoid Bun's 64KB buffer limit
  // eslint-disable-next-line sonarjs/pseudo-random -- Test utility, not security-sensitive
  const stdoutFile = safePath.join(normalizedTmpdir(), `vat-test-stdout-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  // eslint-disable-next-line sonarjs/pseudo-random -- Test utility, not security-sensitive
  const stderrFile = safePath.join(normalizedTmpdir(), `vat-test-stderr-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);

  // Open file descriptors
  const stdoutFd = fs.openSync(stdoutFile, 'w');
  const stderrFd = fs.openSync(stderrFile, 'w');

  try {
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    const result = spawnSync('node', [binPath, ...args], {
      cwd: options?.cwd,
      env: options?.env,
      stdio: ['inherit', stdoutFd, stderrFd],
    });

    // Close file descriptors before reading
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);

    // Read output from files
    const stdout = fs.readFileSync(stdoutFile, 'utf-8');
    const stderr = fs.readFileSync(stderrFile, 'utf-8');

    return {
      status: result.status,
      stdout,
      stderr,
    };
  } finally {
    // Close FDs if not already closed (e.g., spawnSync threw before closeSync)
    try { fs.closeSync(stdoutFd); } catch { /* already closed */ }
    try { fs.closeSync(stderrFd); } catch { /* already closed */ }
    // Cleanup temp files
    try { fs.unlinkSync(stdoutFile); } catch { /* ignore */ }
    try { fs.unlinkSync(stderrFile); } catch { /* ignore */ }
  }
}

/**
 * Execute and parse YAML result (strict).
 *
 * Always attempts to parse YAML from stdout. Throws if no YAML content found.
 * Use this when the command is expected to produce YAML output on success.
 *
 * @see {@link executeCliAndParseYaml} for a lenient variant that returns `{}` on parse failure
 */
export function executeAndParseYaml(
  binPath: string,
  args: string[],
  options?: { cwd?: string }
): { result: CliResult; parsed: Record<string, unknown> } {
  const result = executeCli(binPath, args, options);
  const parsed = parseYamlOutput(result.stdout);
  return { result, parsed };
}

/**
 * Execute command and parse YAML output (convenience wrapper)
 * Alternative signature that takes cwd as third parameter
 */
export function executeCommandAndParse(
  binPath: string,
  args: string[],
  cwd: string
): { result: CliResult; parsed: Record<string, unknown> } {
  return executeAndParseYaml(binPath, args, { cwd });
}

/**
 * Execute scan and parse result
 */
export function executeScanAndParse(
  binPath: string,
  cwd: string
): { result: CliResult; parsed: Record<string, unknown> } {
  return executeAndParseYaml(binPath, ['resources', 'scan'], { cwd });
}

/**
 * Execute validate and parse result
 */
export function executeValidateAndParse(
  binPath: string,
  cwd: string
): { result: CliResult; parsed: Record<string, unknown> } {
  return executeAndParseYaml(binPath, ['resources', 'validate'], { cwd });
}

/**
 * Assert validation failure and check that the expected error string(s) appear
 * in the command's output (combined stdout + stderr). Runs the CLI once — the
 * YAML output carries the error details (file paths, field names, AJV messages)
 * that earlier versions of this helper re-checked via a second `--format text`
 * invocation.
 *
 * @param expectedInOutput  Single string or array of strings that must all
 *                          appear somewhere in the combined stdout/stderr.
 * @returns { result, parsed } for additional assertions (e.g. errorsFound).
 */
export function assertValidationFailureWithError(
  binPath: string,
  projectDir: string,
  expectedInOutput: string | string[]
): { result: CliResult; parsed: Record<string, unknown> } {
  const { result, parsed } = executeValidateAndParse(binPath, projectDir);

  expect(result.status).toBe(1);
  expect(parsed.status).toBe('failed');
  expect(parsed.errorsFound).toBeGreaterThan(0);

  const combined = result.stdout + result.stderr;
  const expectedList = Array.isArray(expectedInOutput) ? expectedInOutput : [expectedInOutput];
  for (const expected of expectedList) {
    expect(combined).toContain(expected);
  }

  return { result, parsed };
}

/**
 * Test helper for config error scenarios
 * Sets up project with invalid config, creates test.md, runs scan, and returns result
 */
export function testConfigError(
  tempDir: string,
  projectName: string,
  invalidConfig: string,
  binPath: string
): CliResult {
  const projectDir = setupTestProject(tempDir, {
    name: projectName,
    config: invalidConfig,
    withDocs: true,
  });

  fs.writeFileSync(safePath.join(projectDir, 'docs/test.md'), '# Test');

  // eslint-disable-next-line sonarjs/no-os-command-from-path
  return spawnSync('node', [binPath, 'resources', 'scan'], {
    encoding: 'utf-8',
    cwd: projectDir,
  });
}

/**
 * Execute a CLI command and parse YAML output if successful (lenient).
 *
 * Only parses YAML when the command exits with status 0 and stdout contains
 * a `---` document marker. Returns `{}` for the parsed field otherwise.
 * Use this when the command may fail and you want to inspect both the raw
 * result and any parsed output without catching parse exceptions.
 *
 * @see {@link executeAndParseYaml} for a strict variant that always parses (throws on missing YAML)
 */
export function executeCliAndParseYaml(
  binPath: string,
  args: string[],
  options?: { cwd?: string }
): { status: number | null; stdout: string; stderr: string; parsed: Record<string, unknown> } {
  const result = executeCli(binPath, args, options);
  let parsed: Record<string, unknown> = {};
  if (result.status === 0 && result.stdout.includes('---')) {
    parsed = parseYamlOutput(result.stdout);
  }
  return { ...result, parsed };
}
