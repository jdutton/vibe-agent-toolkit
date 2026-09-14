/**
 * One pin for every published package's `.` barrel: the runtime export set,
 * recorded in the package's own `test/barrel-exports.test.ts`, which asserts
 * `findBarrelDrift(barrel, PINNED)` is empty in every direction.
 *
 * 🔑 **Pre-1.0 permits breaking freely, but an UNKNOWN surface cannot be broken
 * deliberately — it breaks by accident.** One of 22 published packages had a
 * pin; the other 1,022 exported names (462 in `resources` alone) were invisible
 * until an adopter's build failed. And that one pin was a snapshot, not a
 * ratchet: its header pre-approved additions, and ten of its twelve edits were
 * pure growth — eight of them test scaffolding shipped in a public barrel.
 *
 * ## The ratchet, both ways
 *
 * - A **removal** (a pinned name the barrel no longer exports) is a BREAKING
 *   CHANGE. Do not "fix" the test by deleting the line: restore the export, or
 *   — if the removal is intended — delete the line AND add a `Breaking` entry
 *   to `CHANGELOG.md` naming every symbol dropped and where it moved to.
 * - An **addition** (an exported name the pin does not record) is NOT
 *   automatically fine. A barrel export is a public API line the pre-1.0
 *   policy says must later be removed with a changelog entry, so it needs a
 *   consumer outside the package (not a test — a helper only tests reach
 *   belongs on a test-only subpath, or in `test/`). Add the name in sorted
 *   position only once it has one.
 *
 * Type-only exports do not appear: this is the runtime namespace.
 *
 * The comparison is by NAME only. A renamed function whose old name is kept
 * as an alias passes here and is caught nowhere; that is the floor of a
 * runtime-namespace pin, and the reason the list carries no arity or type.
 */

import { compareCodeUnits } from '@vibe-agent-toolkit/utils';

/** How a barrel disagrees with its pin. Every list empty means the pin holds. */
export interface BarrelDrift {
  /** Exported by the barrel, not recorded — an addition awaiting a consumer. */
  readonly added: readonly string[];
  /** Recorded, no longer exported — a breaking change. */
  readonly removed: readonly string[];
  /** Pinned names out of sorted order, so a diff of the pin shows the change. */
  readonly unsorted: readonly string[];
}

/** The barrel's runtime export names, sorted the way the pin is. */
export function runtimeExportNames(barrel: Record<string, unknown>): string[] {
  return Object.keys(barrel).sort(compareCodeUnits);
}

/**
 * Every disagreement between a loaded barrel and its recorded export set.
 *
 * @param barrel - The imported module namespace
 * @param pinned - The recorded names
 * @returns Additions, removals, and any recorded name out of sorted position
 */
export function findBarrelDrift(barrel: Record<string, unknown>, pinned: readonly string[]): BarrelDrift {
  const actual = new Set(Object.keys(barrel));
  const recorded = new Set(pinned);
  const sorted = [...pinned].sort(compareCodeUnits);
  return {
    added: runtimeExportNames(barrel).filter((name) => !recorded.has(name)),
    removed: pinned.filter((name) => !actual.has(name)),
    unsorted: pinned.filter((name, index) => name !== sorted[index]),
  };
}
