/**
 * Where the stated limits live in the machine-readable output: on the ENVELOPE,
 * exactly once, and on no answer.
 *
 * ## Why this is a unit test and why it asserts a COUNT
 *
 * The defect this guards against was invisible to every assertion that existed.
 * `answerDocument` attached `limits`, `modelledBehaviours` and `boundsStatement`
 * to every answer, and the system test read them off `answers[0]` — which passes
 * identically whether the block appears once or six thousand times. Nothing in a
 * one-path suite can tell those two apart, because with one answer they are the
 * same document. So the assertion here is over a SWEEP of several answers, and it
 * counts occurrences in the serialized envelope rather than checking presence.
 *
 * On this repository a `--all` sweep answers for thousands of paths, and the
 * block is ~9.7 KB — the per-answer copy was tens of megabytes of one paragraph.
 * That is the JSON spelling of the burial `renderEnvelopeText` documents itself
 * as refusing to do in text ("on a `--all` sweep would bury the answers under
 * thousands of identical paragraphs"), so the two renderings disagreed with each
 * other while both looked correct in isolation.
 *
 * ⛔ Limits are found by `id`, never by index. `CLAUDE_CONTEXT_LIMITS` is grouped
 * by `direction` and grows; an index-based assertion passes today and pins the
 * wrong sentence tomorrow.
 */

import {
  CLAUDE_CONTEXT_BOUNDS_STATEMENT,
  type LoadedContextAnswer,
  type Projection,
} from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import {
  answerDocument,
  contextEnvelope,
  type ContextAnswerDocument,
} from '../../../src/commands/claude/context.js';

/** The three fields that belong to the run, not to a path. */
const RUN_SCOPED_FIELDS = ['limits', 'modelledBehaviours', 'boundsStatement'] as const;

/**
 * An empty projection — twelve empty tables.
 *
 * The document's SHAPE is what is under test, and shape does not depend on the
 * rows: `account()` over no rows still produces totals, and its correctness is
 * pinned in `@vibe-agent-toolkit/resources` where it lives. Populating a tree
 * here would buy nothing and make this a slow test of somebody else's code.
 *
 * @returns A projection with every table empty
 */
function emptyProjection(): Projection {
  return {
    roots: [],
    resources: [],
    resourceRealizations: [],
    resourceExtents: [],
    resourceTags: [],
    realizationConditions: [],
    resolutionContexts: [],
    zoneProvenance: [],
    blobs: [],
    blobReferences: [],
    blobSections: [],
    blobConditions: [],
  };
}

/**
 * An answer for one path, with nothing loaded at it.
 *
 * @param input - The path this answer is about
 * @returns The query answer
 */
function answerFor(input: string): LoadedContextAnswer {
  return {
    kind: 'answer',
    input,
    directory: input,
    file: null,
    rows: [],
    conditions: [],
    overBudgetRules: [],
    unattributedImports: [],
  };
}

/**
 * The answer documents for a sweep of several paths.
 *
 * @param inputs - The paths swept
 * @returns One answer document per path
 */
function sweep(inputs: readonly string[]): ContextAnswerDocument[] {
  const projection = emptyProjection();
  return inputs.map((input) => answerDocument(answerFor(input), projection, false));
}

describe('vat claude context — the limits belong to the envelope', () => {
  it('states the whole block exactly ONCE across a many-answer sweep', () => {
    const envelope = contextEnvelope('/repo', sweep(['a', 'b', 'c', 'd', 'e']));

    // The count is the assertion. Presence passes with six thousand copies.
    const serialized = JSON.stringify(envelope);
    const occurrences = serialized.split(JSON.stringify(CLAUDE_CONTEXT_BOUNDS_STATEMENT).slice(1, -1)).length - 1;
    expect(occurrences).toBe(1);
    expect(envelope.answers).toHaveLength(5);
  });

  it('puts no run-scoped field on any answer document', () => {
    const documents = sweep(['a', 'b', 'c']);

    for (const document of documents) {
      for (const field of RUN_SCOPED_FIELDS) {
        // `in`, not `=== undefined`: a field present and explicitly undefined
        // still serializes a key in yaml and still says "this answer has its
        // own caveats" to a reader of the type.
        expect(field in document).toBe(false);
      }
    }
  });

  it('carries the block on the envelope, found by id rather than by position', () => {
    const envelope = contextEnvelope('/repo', sweep(['a']));

    expect(envelope.boundsStatement).toContain('neither a floor nor a ceiling');
    const cliff = envelope.limits.find((limit) => limit.id === 'cliff-scope');
    expect(cliff?.direction).toBe('scope');
    expect(envelope.modelledBehaviours.length).toBeGreaterThan(0);
  });

  it('still carries the block when every path was unrealized', () => {
    // The limits bound the METHOD, and a run that realized nothing still used
    // the method. The text rendering omits the section when there is no answer
    // to bound; the envelope is not a rendering and drops nothing.
    const envelope = contextEnvelope('/repo', []);

    expect(envelope.limits.length).toBeGreaterThan(0);
    expect(envelope.boundsStatement).toBe(CLAUDE_CONTEXT_BOUNDS_STATEMENT);
  });
});
