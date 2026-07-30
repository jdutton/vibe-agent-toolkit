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
 * @vendor-claim reviewed=2026-04-18 verify=Per target, run a capability-probe skill that attempts a shell command, a network fetch, a custom script, and `which python3 node npm`, and record which succeeded — one probe per field below. Needs a human operator for claude-chat and claude-cowork.
 *
 * The date above is when the table was written (commit 838e1a51); it has not been
 * re-confirmed since.
 *
 * The `verify=` instruction above was CORRECTED on 2026-07-30 without refreshing
 * `reviewed=`, because the procedure it used to name could not produce the
 * evidence it claimed. It pointed at the empirical harness in
 * `packages/dev-tools/src/compat-empirical/` and said to "diff its observations
 * against this table" — but a `RuntimeObservation` carries only
 * `invocationDetected`, `outputText`, `toolUseEvents`, `exitStatus` and
 * `installResult`. None of those is a capability inventory, so no field below
 * (`localShell`, `browser`, `network`, `customScripts`, `preinstalledBinaries`)
 * has a counterpart to diff against. That harness answers a different question —
 * whether VAT's static verdict matches how a runtime actually behaved on a
 * corpus skill — and is worth running for that, but it cannot falsify this table.
 * Two of its three drivers are human-in-the-loop besides (claude-chat is
 * `manual`, claude-cowork is `scripted-assisted`), so the "just run the harness"
 * reading was never agent-executable either.
 *
 * Nothing here is wired into CI; re-verification is a manual run whichever
 * procedure is used.
 *
 * KNOWN STALE, AND KNOWINGLY LEFT SO — do not re-investigate this from scratch. The
 * structural gate (`validateVendorClaimFreshness` in packages/dev-tools/src/validate-repo-structure.ts,
 * 90-day window, severity `warning`) has this annotation past due and prints a
 * STALE_VENDOR_CLAIM line on every `bun run validate`. It is a warning, so it blocks
 * nothing. Refreshing it costs exactly what `verify=` says, and the cost is a HUMAN
 * OPERATOR, not compute: someone has to sit in front of claude-chat and claude-cowork
 * and run the capability probe by hand (those two drivers are `manual` and
 * `scripted-assisted`). No agent can close this one unattended, which is why it sits.
 * Bump `reviewed=` only after the probes actually run; bumping the date alone converts
 * a true "unwatched" signal into a false "recently confirmed" one.
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
