/**
 * Shared utilities for top-level phase orchestration commands (vat build, vat verify).
 */

import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { createLogger } from '../utils/logger.js';

export interface PhaseOptions {
  marketplace?: string;
  debug?: boolean;
}

export interface Phase {
  name: string;
  args: string[];
}

export interface PhaseResult {
  name: string;
  status: string;
}

/**
 * Build the args array for a claude subcommand phase, appending optional
 * --marketplace and --debug flags when present in options.
 */
export function buildClaudePhaseArgs(subcommand: string, options: PhaseOptions): string[] {
  const args = ['claude', subcommand];
  if (options.marketplace) {
    args.push('--marketplace', options.marketplace);
  }
  if (options.debug) {
    args.push('--debug');
  }
  return args;
}

/**
 * Resolve the absolute path to the vat binary.
 * This file lives in commands/, one level above bin/.
 */
export function resolveBinPath(): string {
  return resolve(join(import.meta.dirname, '../bin/vat.js'));
}

export interface PhaseContext {
  logger: ReturnType<typeof createLogger>;
  startTime: number;
  binPath: string;
}

/**
 * Create the shared phase command context: logger, startTime, and validated bin path.
 * Throws if the phases list is empty (indicating an unknown --only value).
 *
 * @param debugFlag - Whether debug logging is enabled
 * @param phases - Pre-built list of phases to validate
 * @param onlyValue - The --only flag value (for the error message)
 * @param validPhaseNames - Human-readable list of valid phase names (for error message)
 * @returns Initialized phase context
 * @throws Error if phases list is empty
 */
export function createPhaseContext(
  debugFlag: boolean | undefined,
  phases: Phase[],
  onlyValue: string | undefined,
  validPhaseNames: string
): PhaseContext {
  if (phases.length === 0) {
    throw new Error(`Unknown phase: ${onlyValue ?? ''}. Valid phases: ${validPhaseNames}`);
  }
  return {
    logger: createLogger(debugFlag ? { debug: true } : {}),
    startTime: Date.now(),
    binPath: resolveBinPath(),
  };
}

/**
 * Run a single phase by spawning the vat binary with the phase args.
 */
export function runPhase(binPath: string, phase: Phase): PhaseResult {
  const result = spawnSync(process.execPath, [binPath, ...phase.args], {
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  return { name: phase.name, status: result.status === 0 ? 'passed' : 'failed' };
}
