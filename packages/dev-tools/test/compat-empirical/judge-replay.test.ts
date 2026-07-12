/**
 * Round-trip tests for the judge-replay artifact + reJudgeCompletion.
 *
 * No live API calls — we stub the claude runner so we can assert:
 *   1. judgeCompletion persists a complete JudgeCallArtifact when callsDir is
 *      passed, and stamps JudgeResult.judgeCallRef with the relative path.
 *   2. reJudgeCompletion reads the artifact back and produces a fresh
 *      JudgeResult against an optionally different model + system prompt.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- harness-controlled tmpdir paths */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ClaudeRunner } from '../../src/compat-empirical/judge/llm-judge.js';
import { judgeCompletion, reJudgeCompletion } from '../../src/compat-empirical/judge/llm-judge.js';
import type { ClaudeSpawnResult } from '../../src/compat-empirical/runtimes/shared/claude-cli.js';
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
  sessionId?: string;
}

/**
 * Minimal stub of the claude runner surface judgeCompletion / reJudgeCompletion
 * touch — returns a JSON envelope with the verdict. We capture each invocation
 * so tests can assert what CLI args would have been passed to the real claude.
 */
function makeStubRunner(responses: StubResponse[]): { runClaude: ClaudeRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runClaude: ClaudeRunner = async (args) => {
    calls.push(args);
    const next = responses.shift();
    if (!next) throw new Error('stub runner: no more queued responses');
    const result = JSON.stringify({ verdict: next.verdict, rationale: next.rationale, confidence: next.confidence });
    const envelope = JSON.stringify({ type: 'result', is_error: false, result, session_id: next.sessionId ?? 'sess', usage: { output_tokens: 5 } });
    const res: ClaudeSpawnResult = { stdout: envelope, stderr: '', exitCode: 0, timedOut: false };
    return res;
  };
  return { runClaude, calls };
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
  calls: string[][];
}> {
  const { runClaude, calls } = makeStubRunner([stubResponse]);
  await judgeCompletion({
    triggerPrompt: TRIGGER_PROMPT,
    expected: FIXTURE_EXPECTED,
    observation: FIXTURE_OBS,
    runClaude,
    callsDir,
    judgePromptSha: ARTIFACT_SHA,
  });
  const artifactPath = safePath.join(callsDir, ARTIFACT_BASENAME);
  const artifact = JudgeCallArtifactSchema.parse(JSON.parse(readFileSync(artifactPath, 'utf8')));
  return { artifact, calls };
}

describe('judgeCompletion + reJudgeCompletion round-trip', () => {
  it('persists a JudgeCallArtifact with verbatim system+user+response when callsDir is set', async () => {
    const { artifact, calls } = await runJudgeAndLoadArtifact({
      verdict: 'completed',
      rationale: 'looks right',
      confidence: 'high',
      sessionId: 'req_abc',
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
    // CLI args: ['-p', userMessage, '--append-system-prompt', systemPrompt, '--model', model, '--output-format', 'json']
    expect(calls[0]?.[3]).toBe(artifact.systemPrompt);
    expect(calls[0]?.[1]).toBe(artifact.userMessage);
  });

  it('returns a judgeCallRef pointing at the persisted artifact', async () => {
    const { runClaude } = makeStubRunner([
      { verdict: 'completed', rationale: 'looks right', confidence: 'high' },
    ]);
    const result = await judgeCompletion({
      triggerPrompt: TRIGGER_PROMPT,
      expected: FIXTURE_EXPECTED,
      observation: FIXTURE_OBS,
      runClaude,
      callsDir,
      judgePromptSha: ARTIFACT_SHA,
    });
    expect(result.judgeCallRef).toBe(`judge-calls/${ARTIFACT_BASENAME}`);
  });

  it('does NOT persist an artifact when callsDir is omitted', async () => {
    const { runClaude } = makeStubRunner([
      { verdict: 'completed', rationale: 'ok', confidence: 'medium' },
    ]);

    const result = await judgeCompletion({
      triggerPrompt: TRIGGER_PROMPT,
      expected: FIXTURE_EXPECTED,
      observation: FIXTURE_OBS,
      runClaude,
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

    const swappedModel = 'claude-haiku-4-5';
    const { runClaude: reRunner, calls: reCalls } = makeStubRunner([
      { verdict: 'partial', rationale: 'second pass disagrees', confidence: 'low' },
    ]);

    const reResult = await reJudgeCompletion({ artifact, runClaude: reRunner, model: swappedModel });

    expect(reResult.verdict).toBe('partial');
    expect(reResult.judgeModel).toBe(swappedModel);
    // The re-judge call used the persisted system prompt and user message verbatim.
    // CLI args: ['-p', userMessage, '--append-system-prompt', systemPrompt, '--model', model, '--output-format', 'json']
    expect(reCalls).toHaveLength(1);
    expect(reCalls[0]?.[5]).toBe(swappedModel);
    expect(reCalls[0]?.[3]).toBe(artifact.systemPrompt);
    expect(reCalls[0]?.[1]).toBe(artifact.userMessage);
  });

  it('reJudgeCompletion honors systemPromptOverride for prompt A/B', async () => {
    const { artifact } = await runJudgeAndLoadArtifact({
      verdict: 'completed',
      rationale: 'first pass',
      confidence: 'high',
    });

    const newSystemPrompt = '## NEW SYSTEM PROMPT for A/B testing\nBe stricter.';
    const { runClaude: reRunner, calls: reCalls } = makeStubRunner([
      { verdict: 'failed', rationale: 'stricter rubric flags this', confidence: 'medium' },
    ]);

    await reJudgeCompletion({
      artifact,
      runClaude: reRunner,
      systemPromptOverride: newSystemPrompt,
    });

    expect(reCalls[0]?.[3]).toBe(newSystemPrompt);
    expect(reCalls[0]?.[3]).not.toBe(artifact.systemPrompt);
  });
});
