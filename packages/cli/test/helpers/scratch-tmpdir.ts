/**
 * ⛔ DESTRUCTIVE CODE: make a fresh scratch THE temp directory (`TMPDIR` / `TEMP` / `TMP`) for
 * each test (`scratchTmpdirEnv`). A verb that makes and disposes of a temporary directory — a
 * clone, a publish tree, a progress log, a harness root — then does so inside the scratch, and
 * so does every `vat` child a test spawns (it inherits the environment: `executeCli` merges its
 * overrides onto `process.env`). Register it at the top of a suite, before anything runs a verb.
 */

import { registerScratchTmpdir } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach } from 'vitest';

/**
 * @param prefix - The scratch directory's prefix, so a leaked one names its suite
 * @returns The current test's scratch directory
 */
export function useScratchTmpdir(prefix: string): () => string {
  return registerScratchTmpdir(prefix, { beforeEach, afterEach });
}
