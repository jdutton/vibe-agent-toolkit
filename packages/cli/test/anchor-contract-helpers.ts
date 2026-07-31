/**
 * Shared helpers for asserting the audit anchor contract: one run states its
 * base ONCE (`root`) and every `path` / issue `location` beneath it is relative
 * to that base.
 *
 * Used by both the pipeline-seam integration test and the CLI-stdout system
 * test, so the two cannot drift into checking different invariants.
 */

import * as fs from 'node:fs';

import { hasParentTraversalSegment, isAbsoluteAnyPlatform, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

/** Every path-shaped key in audit output that the anchor contract governs. */
const ANCHOR_KEYS = new Set(['path', 'location']);

export interface AnchorSighting {
  /** The key the value appeared under (`path`, `location`, or a `location.file`). */
  key: string;
  /** Dotted trail to the value, so a failure names the finding, not just a count. */
  trail: string;
  value: string;
}

/**
 * A `location` is not always a bare string: an `EvidenceRecord.location` is the
 * object `{ file, line }`. A collector that only looks at string values recurses
 * straight past it, and the inner `file` — not itself an anchor key — is never
 * checked. That blind spot is exactly how an absolute evidence `location.file`
 * shipped under a gate written to forbid absolute anchors, so the object form is
 * unwrapped here rather than walked through.
 *
 * Returns the sighting for an object-valued anchor, or `undefined` when `value`
 * is not one.
 */
function unwrapObjectAnchor(key: string, childTrail: string, value: unknown): AnchorSighting | undefined {
  if (!ANCHOR_KEYS.has(key)) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const file = (value as Record<string, unknown>)['file'];
  // A non-string `file` cannot be resolved by any consumer; report it as an
  // empty anchor so the failure names the finding rather than silently passing.
  return { key: 'file', trail: `${childTrail}.file`, value: typeof file === 'string' ? file : '' };
}

/**
 * Collect EVERY `path` / `location` anchor in an audit document, remembering
 * where each came from. Both anchor shapes count: a bare string, and the
 * `{ file, line }` object an evidence record carries.
 *
 * Exhaustive on purpose: a suite that checks one named property per test is
 * structurally blind to producers added later.
 */
export function collectAnchors(node: unknown, trail: string, out: AnchorSighting[]): void {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) {
      collectAnchors(item, `${trail}[${i}]`, out);
    }
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const childTrail = trail === '' ? key : `${trail}.${key}`;
    if (typeof value === 'string') {
      if (ANCHOR_KEYS.has(key)) out.push({ key, trail: childTrail, value });
      continue;
    }
    const objectAnchor = unwrapObjectAnchor(key, childTrail, value);
    if (objectAnchor !== undefined) out.push(objectAnchor);
    collectAnchors(value, childTrail, out);
  }
}

/** Collect the anchors of a document with its `root` key excluded. */
export function anchorsBelowRoot(document: object): AnchorSighting[] {
  const out: AnchorSighting[] = [];
  collectAnchors({ ...document, root: undefined }, '', out);
  return out;
}

/**
 * Every way an anchor value can violate the contract, as human-readable strings
 * (empty array = contract held). Returning strings rather than a boolean keeps
 * the failure message naming the offending finding.
 *
 * The existence check is the load-bearing one: if `join(root, value)` names a
 * real file, then the value was written against the root the document states —
 * which is simultaneously the joinability guarantee and the uniqueness
 * guarantee, since one relative string against one root cannot denote two files.
 */
export function anchorContractViolations(anchors: readonly AnchorSighting[], root: string): string[] {
  const violations: string[] = [];
  for (const anchor of anchors) {
    if (anchor.value === '') {
      // The root itself must be spelled `.`, never blank — an empty path is a
      // value every consumer has to special-case.
      violations.push(`${anchor.trail} is empty`);
    } else if (isAbsoluteAnyPlatform(anchor.value)) {
      violations.push(`${anchor.trail} is absolute: ${anchor.value}`);
    } else if (anchor.value !== toForwardSlash(anchor.value)) {
      violations.push(`${anchor.trail} is not forward-slashed: ${anchor.value}`);
    } else if (hasParentTraversalSegment(anchor.value)) {
      violations.push(`${anchor.trail} escapes the root: ${anchor.value}`);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- root and value both come from our own audit run
    } else if (!fs.existsSync(safePath.join(root, anchor.value))) {
      violations.push(`${anchor.trail} does not resolve under root: ${anchor.value}`);
    }
  }
  return violations;
}

/** The distinct `location` values in a document that name a plugin manifest. */
export function pluginManifestLocations(anchors: readonly AnchorSighting[]): string[] {
  const locations = new Set(
    anchors
      .filter((a) => a.key === 'location' && a.value.endsWith('.claude-plugin/plugin.json'))
      .map((a) => a.value),
  );
  return [...locations].sort((a, b) => a.localeCompare(b));
}
