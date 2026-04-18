/**
 * Runtime profiles — the single source of truth for what each Claude runtime
 * provides and lacks. The verdict engine consults this table; no per-scanner
 * hardcoded impact logic.
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
