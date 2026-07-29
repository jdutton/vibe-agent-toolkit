/**
 * Runtime profiles — the single source of truth for what each Claude runtime
 * provides and lacks. The verdict engine consults this table; no per-scanner
 * hardcoded impact logic.
 *
 * Every field below is a claim about what someone else's runtime does — not about
 * this codebase — so no test here can falsify one. The suite asserts the table's
 * shape; a runtime gaining a browser or losing a preinstalled binary makes the
 * verdict engine wrong while every check stays green.
 *
 * @vendor-claim reviewed=2026-04-18 verify=Run the empirical harness in packages/dev-tools/src/compat-empirical/ against each target, then diff its observations against this table
 *
 * The date above is when the table was written (commit 838e1a51); it has not been
 * re-confirmed since. The harness named above exists but is not wired into CI, so
 * re-verification is a manual run.
 */

import type { Target } from './types.js';

export type CapabilityYesNo = 'yes' | 'no';
export type NetworkLevel = 'full' | 'restricted' | 'none';

export interface RuntimeProfile {
  localShell: CapabilityYesNo;
  browser: CapabilityYesNo;
  network: NetworkLevel;
  customScripts: CapabilityYesNo;
  preinstalledBinaries: ReadonlySet<string>;
}

export const RUNTIME_PROFILES: Record<Target, RuntimeProfile> = {
  'claude-chat': {
    localShell: 'no',
    browser: 'yes',
    network: 'full',
    customScripts: 'no',
    preinstalledBinaries: new Set(),
  },
  'claude-cowork': {
    localShell: 'yes',
    browser: 'no',
    network: 'restricted',
    customScripts: 'yes',
    preinstalledBinaries: new Set(['python3', 'node', 'npm']),
  },
  'claude-code': {
    localShell: 'yes',
    browser: 'yes',
    network: 'full',
    customScripts: 'yes',
    preinstalledBinaries: new Set(),
  },
};

export function getRuntimeProfile(target: Target): RuntimeProfile {
  return RUNTIME_PROFILES[target];
}
