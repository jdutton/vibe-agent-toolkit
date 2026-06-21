import { z } from 'zod';

export const StagedEntrySchema = z.object({
  name: z.string().min(1),
  identity: z.string().min(1),
  contentHash: z.string().min(1),
}).strict();

export type StagedEntry = z.infer<typeof StagedEntrySchema>;

export const StagedManifestSchema = z.object({
  fingerprint: z.string().min(1),
  entries: z.array(StagedEntrySchema),
}).strict();

export type StagedManifest = z.infer<typeof StagedManifestSchema>;

export interface ReconcilePlan {
  toStage: StagedEntry[];
  toPrune: StagedEntry[];
  unchanged: StagedEntry[];
}

/**
 * Make-style reconcile. An entry is `unchanged` only when BOTH identity and
 * contentHash match the current manifest (spec §11b: content-bound, the
 * manifest is never trusted on its word). Everything desired-but-not-unchanged
 * is staged; everything current-but-not-desired is pruned.
 */
export function computeReconcilePlan(
  desired: StagedEntry[],
  current: StagedManifest | null,
): ReconcilePlan {
  const currentByName = new Map((current?.entries ?? []).map(e => [e.name, e]));
  const desiredNames = new Set(desired.map(e => e.name));

  const toStage: StagedEntry[] = [];
  const unchanged: StagedEntry[] = [];
  for (const want of desired) {
    const have = currentByName.get(want.name);
    if (have?.identity === want.identity && have?.contentHash === want.contentHash) {
      unchanged.push(want);
    } else {
      toStage.push(want);
    }
  }
  const toPrune = (current?.entries ?? []).filter(e => !desiredNames.has(e.name));

  return { toStage, toPrune, unchanged };
}
