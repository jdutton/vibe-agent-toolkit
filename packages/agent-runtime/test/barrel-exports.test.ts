/**
 * The `.` barrel's runtime export set — a ratchet, both ways. How to react when
 * this fails is written on `findBarrelDrift` in
 * `packages/dev-tools/src/pin-barrel-exports.ts`; in one line: a removal is a
 * breaking change (restore it, or record it in CHANGELOG.md), an addition is
 * deliberate and needs a consumer outside this package before it is added here.
 */

import { describe, expect, it } from 'vitest';

import { findBarrelDrift } from '../../dev-tools/src/pin-barrel-exports.js';

const BARREL_EXPORTS = [
  'EVENT_INVALID_RESPONSE',
  'EVENT_REJECTED',
  'EVENT_TIMEOUT',
  'EVENT_UNAVAILABLE',
  'FileSessionStore',
  'LLM_INVALID_OUTPUT',
  'LLM_RATE_LIMIT',
  'LLM_REFUSAL',
  'LLM_TIMEOUT',
  'LLM_TOKEN_LIMIT',
  'LLM_UNAVAILABLE',
  'MemorySessionStore',
  'RESULT_ERROR',
  'RESULT_IN_PROGRESS',
  'RESULT_SUCCESS',
  'SessionNotFoundError',
  'andThen',
  'batchConvert',
  'createConversationalContext',
  'createError',
  'createInProgress',
  'createInitialSession',
  'createSuccess',
  'defineAgenticResearcher',
  'defineConversationalAssistant',
  'defineExternalEventIntegrator',
  'defineFunctionEventConsumer',
  'defineFunctionOrchestrator',
  'defineLLMAnalyzer',
  'defineLLMCoordinator',
  'defineLLMEventHandler',
  'definePureFunction',
  'defineTwoPhaseConversationalAssistant',
  'executeExternalEvent',
  'executeLLMAnalyzer',
  'executeLLMCall',
  'generateExtractionPrompt',
  'generateGatheringPrompt',
  'isSessionExpired',
  'mapResult',
  'match',
  'unwrap',
  'updateSessionAccess',
  'validateAgentInput',
  'validateSessionId',
  'withRetry',
  'withTiming',
];

describe('@vibe-agent-toolkit/agent-runtime — the `.` barrel export surface', () => {
  it('exports exactly the recorded set, sorted — nothing added, dropped, or out of order', async () => {
    expect(findBarrelDrift(await import('../src/index.js'), BARREL_EXPORTS)).toEqual({ added: [], removed: [], unsorted: [] });
  });
});
