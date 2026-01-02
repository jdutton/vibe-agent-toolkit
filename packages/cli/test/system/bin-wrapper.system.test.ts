/**
 * System test for bin wrapper (vat command)
 * Tests that the bin wrapper correctly detects context and executes
 */

import { describe, expect, it } from 'vitest';

import { executeBunVat } from './test-common.js';

describe('Bin wrapper (vat command)', () => {
  it('should execute vat command with bun run', () => {
    // Test the dev convenience script
    const result = executeBunVat(['--version']);

    expect(result.status).toBe(0);
    // Version format matching is safe despite backtracking potential
    // eslint-disable-next-line sonarjs/slow-regex
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
  });

  it('should handle --help flag', () => {
    const result = executeBunVat(['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Vibe Agent Toolkit');
    expect(result.stdout).toContain('resources');
  });

  it('should handle --help --verbose flag', () => {
    const result = executeBunVat(['--help', '--verbose']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('# vat - Vibe Agent Toolkit CLI');
    expect(result.stdout).toContain('## Overview');
  });

  it('should pass through subcommands correctly', () => {
    const result = executeBunVat(['resources', '--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Markdown resource scanning');
  });
});
