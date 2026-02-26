/**
 * Rule conflict analyzer — detects permission rules that are effectively dead
 * due to Claude Code's rule evaluation order: deny → ask → allow (first match wins).
 *
 * Three conflict kinds:
 *   shadowed-by-deny  — ask or allow rule subsumed by a deny rule (never reached)
 *   shadowed-by-ask   — allow rule subsumed by an ask rule (never reached)
 *   redundant         — rule within the same bucket subsumed by a broader sibling
 */

import { isSubsumedBy } from './permission-matcher.js';
import type { EffectiveSettings, ProvenanceRule } from './settings-merger.js';

export type RuleConflictKind = 'shadowed-by-deny' | 'shadowed-by-ask' | 'redundant';

export interface RuleConflict {
  kind: RuleConflictKind;
  /** The dead or redundant rule */
  rule: ProvenanceRule;
  /** The rule that shadows it */
  shadowedBy: ProvenanceRule;
}

/**
 * Return the first rule in `candidates` that subsumes `target`, or undefined.
 */
function findShadowingRule(
  target: ProvenanceRule,
  candidates: ProvenanceRule[]
): ProvenanceRule | undefined {
  return candidates.find(
    candidate => candidate !== target && isSubsumedBy(target.rule, candidate.rule)
  );
}

/**
 * Analyze effective permission rules for conflicts.
 *
 * Rule evaluation order (Claude Code): deny → ask → allow (first match wins).
 * - deny always blocks
 * - ask always prompts
 * - allow only fires if nothing else matched first
 *
 * Returns an array of RuleConflict objects (empty if no conflicts found).
 */
export function analyzeRuleConflicts(effective: EffectiveSettings): RuleConflict[] {
  const conflicts: RuleConflict[] = [];
  const { deny, ask, allow } = effective.permissions;

  // ask rules shadowed by deny rules
  for (const askRule of ask) {
    const shadower = findShadowingRule(askRule, deny);
    if (shadower !== undefined) {
      conflicts.push({ kind: 'shadowed-by-deny', rule: askRule, shadowedBy: shadower });
    }
  }

  // allow rules shadowed by deny rules
  for (const allowRule of allow) {
    const denyShadower = findShadowingRule(allowRule, deny);
    if (denyShadower !== undefined) {
      conflicts.push({ kind: 'shadowed-by-deny', rule: allowRule, shadowedBy: denyShadower });
      continue;
    }

    // allow rules shadowed by ask rules (only if not already reported as shadowed-by-deny)
    const askShadower = findShadowingRule(allowRule, ask);
    if (askShadower !== undefined) {
      conflicts.push({ kind: 'shadowed-by-ask', rule: allowRule, shadowedBy: askShadower });
    }
  }

  // Redundant rules within each bucket (broader sibling subsumes narrower)
  for (const bucket of [deny, ask, allow]) {
    for (const rule of bucket) {
      const shadower = findShadowingRule(rule, bucket);
      if (shadower !== undefined) {
        conflicts.push({ kind: 'redundant', rule, shadowedBy: shadower });
      }
    }
  }

  return conflicts;
}
