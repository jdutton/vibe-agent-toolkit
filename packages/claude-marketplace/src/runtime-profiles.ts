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
 * @vendor-claim reviewed=2026-04-18 verify=Per target, run a capability-probe skill that attempts a shell command, a network fetch, a custom script, and `which python3 node npm`, and record which succeeded — one probe per field below. Needs a human operator for claude-chat and claude-cowork. Public docs can FALSIFY cells for free (see the block below) but never confirm the table; only bump reviewed= for probes actually run.
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
 * KNOWN STALE, AND KNOWN WRONG IN AT LEAST ONE LIVE FIELD. The structural gate
 * (`validateVendorClaimFreshness` in packages/dev-tools/src/validate-repo-structure.ts, 90-day
 * window, severity `warning`) has this annotation past due. It is a warning, so it blocks nothing.
 *
 * CONFIRMING the table still needs a human operator — someone has to sit in front of claude-chat
 * and claude-cowork and run the capability probe by hand (those drivers are `manual` and
 * `scripted-assisted`). But this block used to say "do not re-investigate", and that was wrong:
 * public support and platform docs FALSIFY several cells for free. Treat a do-not-re-investigate
 * note as an EXPIRING claim.
 *
 * ⚠️ Believed wrong as of 2026-08-27, from published docs rather than a probe — recorded here
 * rather than edited into the table, because changing a value on second-hand reading would make the
 * table wrong in a new direction without moving it any closer to verified:
 * - `claude-cowork.browser: 'no'` — Cowork drives a browser (embedded in Claude Desktop, or Claude
 *   in Chrome). This is a LIVE field: `verdict-engine.ts` reads it.
 * - `claude-chat.preinstalledBinaries: ∅` — falsified as empty (bash and Python are documented for
 *   the code-execution container), though no public doc gives an inventory. LIVE field.
 * - `claude-chat.localShell: 'no'` — literally true of the user's machine, but `verdict-engine.ts`
 *   reads this field as "can a skill run a shell command", and under that meaning it is wrong.
 *   The defect is that the field's NAME and its USE disagree.
 * - `claude-chat.customScripts: 'no'` and `claude-chat.network: 'full'` — both wrong (claude.ai
 *   runs custom Skills; network varies by plan and admin setting). Both are DEAD fields: nothing
 *   reads them, so their wrongness changes no verdict.
 *
 * 🔑 `network` and `customScripts` have NO readers anywhere in the repo. `verdict-engine.ts`
 * consults `localShell`, `browser` and `preinstalledBinaries` only. Fix the table or delete those
 * two columns — do not keep maintaining them. Tracked in issue #207.
 *
 * ⛔ Do NOT bump `reviewed=` for any of this. Nothing above was probed; falsifying a cell is not
 * verifying the table, and the date is the only watcher this claim has.
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
