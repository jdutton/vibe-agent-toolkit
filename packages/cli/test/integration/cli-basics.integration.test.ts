import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {  dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, it, expect } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binPath = safePath.resolve(__dirname, '../../dist/bin.js');

function runVat(...args: string[]): SpawnSyncReturns<string> {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- node is required for CLI integration tests
  return spawnSync('node', [binPath, ...args], { encoding: 'utf-8' });
}

describe('CLI basics (integration)', () => {
  it('should show version', () => {
    const result = runVat('--version');

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('should show help', () => {
    const result = runVat('--help');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('vat');
    expect(result.stdout).toContain('Usage:');
  });

  it('should handle unknown commands', () => {
    const result = runVat('unknown');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unknown command');
  });
});

/**
 * Absence pin for the deleted `vat pipeline` verb.
 *
 * `pipeline` was an internal dev instrument that appeared in the DEFAULT
 * `vat --help`, advertising a non-product surface to every adopter. It was
 * deleted from the CLI; the oracles it drove live on as repo test
 * infrastructure, reachable only from tests.
 *
 * Both assertions are written to be falsifiable rather than vacuous:
 *
 * - The help assertion anchors on the command-list entry shape (two-space
 *   indent, then the verb) and is guarded by a positive control on a verb that
 *   IS supposed to be there - so an empty or garbled stdout fails loudly
 *   instead of passing by absence.
 * - The invocation assertion checks the *unknown-command* message, not merely a
 *   non-zero exit. `vat pipeline` with no subcommand ALREADY exited 1 while the
 *   verb existed (Commander prints group help to stderr and exits 1), so
 *   `status !== 0` alone would have been true before the deletion too.
 */
describe('deleted `pipeline` verb (absence pin)', () => {
  it('does not list a pipeline command in `vat --help`', () => {
    const result = runVat('--help');

    expect(result.status).toBe(0);
    // Positive control: the command list is really present in this stdout.
    expect(result.stdout).toMatch(/^ {2}audit\b/m);
    expect(result.stdout).not.toMatch(/^ {2}pipeline\b/m);
  });

  it('rejects `vat pipeline` as an unknown command', () => {
    const result = runVat('pipeline');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unknown command 'pipeline'");
  });
});
