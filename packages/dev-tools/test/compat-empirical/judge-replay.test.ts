/**
 * Round-trip tests for the judge-replay artifact + reJudgeCompletion.
 *
 * No live API calls — we stub the Anthropic client so we can assert:
 *   1. judgeCompletion persists a complete JudgeCallArtifact when callsDir is
 *      passed, and stamps JudgeResult.judgeCallRef with the relative path.
 *   2. reJudgeCompletion reads the artifact back and produces a fresh
 *      JudgeResult against an optionally different model + system prompt.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- harness-controlled tmpdir paths */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';

import type Anthropic from '@anthropic-ai/sdk';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { judgeCompletion, reJudgeCompletion } from '../../src/compat-empirical/judge/llm-judge.js';
import {
  JudgeCallArtifactSchema,
  type ExpectedBehavior,
  type RuntimeObservation,
} from '../../src/compat-empirical/types.js';

const TRIGGER_PROMPT = 'do the thing';
const ARTIFACT_BASENAME = 'skill-test-pos-1-claude-code-0.json';
const ARTIFACT_SHA = 'sha-original';

const FIXTURE_OBS: RuntimeObservation = {
  skillId: 'skill-test',
  target: 'claude-code',
  startedAt: '2026-05-26T00:00:00.000Z',
  durationMs: 100,
  exitStatus: 'completed',
  invocationDetected: true,
  outputText: 'did the thing',
  toolUseEvents: [],
  errors: [],
  installResult: { ok: true, notes: 'installed' },
  transcriptPath: 'transcripts/skill-test.log',
  driverMode: 'scripted',
  promptId: 'pos-1',
  attemptIdx: 0,
};

const FIXTURE_EXPECTED: ExpectedBehavior = {
  description: 'invoke the test skill',
  invocationSignals: ['thing'],
};

interface StubResponse {
  verdict: string;
  rationale: string;
  confidence: 'high' | 'medium' | 'low';
  usage?: { input_tokens: number; output_tokens: number };
  requestId?: string;
}

/**
 * Minimal stub of the Anthropic client surface judgeCompletion / reJudgeCompletion
 * touch — `messages.create` returning a tool_use content block keyed to the
 * `record_verdict` tool. We capture each invocation so tests can assert what
 * the real client would have received.
 */
function makeStubClient(responses: StubResponse[]): { client: Anthropic; calls: Anthropic.Messages.MessageCreateParams[] } {
  const calls: Anthropic.Messages.MessageCreateParams[] = [];
  const client = {
    messages: {
      create: async (params: Anthropic.Messages.MessageCreateParams) => {
        calls.push(params);
        const next = responses.shift();
        if (!next) throw new Error('stub client: no more queued responses');
        return {
          id: 'msg_stub',
          type: 'message',
          role: 'assistant',
          model: typeof params.model === 'string' ? params.model : 'stub-model',
          stop_reason: 'tool_use',
          stop_sequence: null,
          content: [
            {
              type: 'tool_use',
              id: 'tool_stub',
              name: 'record_verdict',
              input: {
                verdict: next.verdict,
                rationale: next.rationale,
                confidence: next.confidence,
              },
            },
          ],
          usage: next.usage ?? { input_tokens: 10, output_tokens: 5 },
          _request_id: next.requestId,
        };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

let tmpRoot: string;
let callsDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-judge-replay-test-'));
  callsDir = safePath.join(tmpRoot, 'judge-calls');
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Drives a single judgeCompletion call against the shared FIXTURE_OBS/EXPECTED
 * inputs and immediately reads back the persisted artifact. Extracted to keep
 * the round-trip and override tests free of repeated setup.
 */
async function runJudgeAndLoadArtifact(stubResponse: StubResponse): Promise<{
  artifact: ReturnType<typeof JudgeCallArtifactSchema.parse>;
  firstStubCall: Anthropic.Messages.MessageCreateParams | undefined;
}> {
  const { client, calls } = makeStubClient([stubResponse]);
  await judgeCompletion({
    triggerPrompt: TRIGGER_PROMPT,
    expected: FIXTURE_EXPECTED,
    observation: FIXTURE_OBS,
    client,
    callsDir,
    judgePromptSha: ARTIFACT_SHA,
  });
  const artifactPath = safePath.join(callsDir, ARTIFACT_BASENAME);
  const artifact = JudgeCallArtifactSchema.parse(JSON.parse(readFileSync(artifactPath, 'utf8')));
  return { artifact, firstStubCall: calls[0] };
}

describe('judgeCompletion + reJudgeCompletion round-trip', () => {
  it('persists a JudgeCallArtifact with verbatim system+user+response when callsDir is set', async () => {
    const { artifact, firstStubCall } = await runJudgeAndLoadArtifact({
      verdict: 'completed',
      rationale: 'looks right',
      confidence: 'high',
      requestId: 'req_abc',
    });

    expect(readdirSync(callsDir)).toContain(ARTIFACT_BASENAME);
    expect(artifact.skillId).toBe('skill-test');
    expect(artifact.target).toBe('claude-code');
    expect(artifact.promptId).toBe('pos-1');
    expect(artifact.attemptIdx).toBe(0);
    expect(artifact.judgePromptSha).toBe(ARTIFACT_SHA);
    expect(artifact.systemPrompt.length).toBeGreaterThan(0);
    expect(artifact.userMessage).toContain(TRIGGER_PROMPT);
    expect(artifact.requestId).toBe('req_abc');
    expect(artifact.responseContent).toHaveLength(1);

    // Sanity-check that the stub saw the same system prompt + user message we
    // round-tripped through the artifact.
    expect(firstStubCall?.system).toBe(artifact.systemPrompt);
    expect(firstStubCall?.messages[0]?.content).toBe(artifact.userMessage);
  });

  it('returns a judgeCallRef pointing at the persisted artifact', async () => {
    const { client } = makeStubClient([
      { verdict: 'completed', rationale: 'looks right', confidence: 'high' },
    ]);
    const result = await judgeCompletion({
      triggerPrompt: TRIGGER_PROMPT,
      expected: FIXTURE_EXPECTED,
      observation: FIXTURE_OBS,
      client,
      callsDir,
      judgePromptSha: ARTIFACT_SHA,
    });
    expect(result.judgeCallRef).toBe(`judge-calls/${ARTIFACT_BASENAME}`);
  });

  it('does NOT persist an artifact when callsDir is omitted', async () => {
    const { client } = makeStubClient([
      { verdict: 'completed', rationale: 'ok', confidence: 'medium' },
    ]);

    const result = await judgeCompletion({
      triggerPrompt: TRIGGER_PROMPT,
      expected: FIXTURE_EXPECTED,
      observation: FIXTURE_OBS,
      client,
    });

    expect(result.judgeCallRef).toBeUndefined();
    // No directory created.
    expect(() => readdirSync(callsDir)).toThrow();
  });

  it('replays a persisted artifact through reJudgeCompletion with a swapped model', async () => {
    const { artifact } = await runJudgeAndLoadArtifact({
      verdict: 'completed',
      rationale: 'first pass',
      confidence: 'high',
    });

    const swappedModel = 'claude-haiku-4-5-20251001';
    const { client: reClient, calls: reCalls } = makeStubClient([
      { verdict: 'partial', rationale: 'second pass disagrees', confidence: 'low' },
    ]);

    const reResult = await reJudgeCompletion({ artifact, client: reClient, model: swappedModel });

    expect(reResult.verdict).toBe('partial');
    expect(reResult.judgeModel).toBe(swappedModel);
    // The re-judge call used the persisted system prompt and user message verbatim.
    expect(reCalls).toHaveLength(1);
    expect(reCalls[0]?.model).toBe(swappedModel);
    expect(reCalls[0]?.system).toBe(artifact.systemPrompt);
    expect(reCalls[0]?.messages[0]?.content).toBe(artifact.userMessage);
  });

  it('reJudgeCompletion honors systemPromptOverride for prompt A/B', async () => {
    const { artifact } = await runJudgeAndLoadArtifact({
      verdict: 'completed',
      rationale: 'first pass',
      confidence: 'high',
    });

    const newSystemPrompt = '## NEW SYSTEM PROMPT for A/B testing\nBe stricter.';
    const { client: reClient, calls: reCalls } = makeStubClient([
      { verdict: 'failed', rationale: 'stricter rubric flags this', confidence: 'medium' },
    ]);

    await reJudgeCompletion({
      artifact,
      client: reClient,
      systemPromptOverride: newSystemPrompt,
    });

    expect(reCalls[0]?.system).toBe(newSystemPrompt);
    expect(reCalls[0]?.system).not.toBe(artifact.systemPrompt);
  });
});
